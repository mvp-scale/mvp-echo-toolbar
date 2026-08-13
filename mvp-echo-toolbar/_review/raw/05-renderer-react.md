# Renderer (React) Architectural Review

Scope: `app/renderer/app/CaptureApp.tsx`, `components/SettingsPanel.tsx`, `PopupApp.tsx`,
`components/WelcomeScreen.tsx`, `components/TranscriptionDisplay.tsx`, `components/StatusIndicator.tsx`,
`main.tsx`, `popup-main.tsx`, `welcome-main.tsx`, `styles/globals.css`, `tailwind.config.js`,
`index.html`, `popup.html`, `welcome.html`. All files read in full. `app/preload/preload.js` was
also read (not in-scope for edits) to verify an IPC-payload claim in finding 2.

---

### [P1] Settings text inputs are persisted on every keystroke, no debounce — can silently revert to a stale value
- **Where:** `app/renderer/app/components/SettingsPanel.tsx:269-278`
- **What:** The effect that saves `endpointUrl`/`apiKey` to the main process fires on every state change with no debounce. Since `ipc.invoke('cloud:configure', ...)` is async, a fast typist can fire N in-flight IPC calls; if an earlier call's promise resolves after a later one (out-of-order under IPC/disk latency), the persisted config is silently overwritten by the older, incomplete string — the main-process-persisted value can then permanently disagree with what's shown in the input until the user edits it again.
- **Evidence:**
  ```tsx
  useEffect(() => {
    if (!configLoaded) return;
    const ipc = ipcRef.current;
    if (!ipc) return;

    ipc.invoke('cloud:configure', {
      endpointUrl,
      apiKey,
    }).catch((err: Error) => console.warn('Failed to save cloud config:', err));
  }, [configLoaded, endpointUrl, apiKey]);
  ```
- **Impact:** Every keystroke in the Endpoint URL or API Key field round-trips to the main process; under any IPC/disk latency, the persisted config can end up holding an earlier partial value than what the user sees on screen, with no error surfaced (the `.catch` only logs to console).
- **Fix:** Debounce the save (e.g. 400-600ms after the last keystroke) and/or save on blur instead of on every keystroke; drop stale in-flight writes by sequencing with a monotonic counter like `CaptureApp`'s `requestGenRef` pattern.

---

### [P1] WebGPU model switch mid-session desyncs `selectedModelRef` in the hidden capture window
- **Where:** `app/renderer/app/CaptureApp.tsx:91`, `:131-137`, `:346`, `:370`; `app/preload/preload.js:68-72`
- **What:** `CaptureApp` only refreshes `selectedModelRef.current` at mount (line 91) or after a non-WebGPU ("standard path") stop (line 370). The IPC event that tells the hidden window to re-init the WebGPU orchestrator after a Settings-panel model switch carries **no model id** — it's a bare notify (`ipcRenderer.on('webgpu:init-orchestrator', () => callback())`). So after switching between WebGPU models in Settings without an app restart, the orchestrator itself loads the new model, but `selectedModelRef.current` — used to label the transcription result — keeps the old id.
- **Evidence:**
  ```tsx
  // CaptureApp.tsx:131-137 — no payload, can't refresh selectedModelRef
  const unsub = api.onWebgpuInitOrchestrator(() => {
    console.log('CaptureApp: Received webgpu:init-orchestrator from main');
    initWebGpuOrchestrator();
  });
  ```
  ```tsx
  // CaptureApp.tsx:342-348 — tagged with a ref that may now be stale
  electronAPI.webgpuStoreTranscription({
    text: result.text,
    processingTime: result.processingTime,
    engine: `webgpu (${selectedModelRef.current})`,
    model: selectedModelRef.current,
    language: 'en',
  });
  ```
- **Impact:** After switching WebGPU models via Settings (e.g. English → Multilingual) without restarting, every subsequent transcription is mislabeled with the previous model's id in its stored metadata (visible via `PopupApp`'s `modelDisplay`), even though the correct model actually ran the inference.
- **Fix:** Either include the model id in the `webgpu:init-orchestrator` IPC payload and update `selectedModelRef.current` from it, or have `CaptureApp` re-read `cloud:get-config` on receipt of that event (same pattern already used post-stop on the standard path).

---

### [P1] Welcome window can render blank indefinitely with no dismiss affordance
- **Where:** `app/renderer/app/welcome-main.tsx:19-36`
- **What:** `WelcomeApp` renders `null` until `getAppVersion()` resolves. There is a `.catch` for rejection but no timeout for a hang, and while `version` is falsy there is zero UI — not even a way to close the window (that control lives inside `WelcomeScreen`, which hasn't mounted yet).
- **Evidence:**
  ```tsx
  function WelcomeApp() {
    const [version, setVersion] = useState('');

    useEffect(() => {
      const api = (window as any).electronAPI;
      if (api?.getAppVersion) {
        api.getAppVersion()
          .then((v: string) => setVersion(v))
          .catch(() => setVersion('3.0.0'));
      } else {
        setVersion('3.0.0');
      }
    }, []);

    if (!version) return null;
  ```
- **Impact:** If the `app:get-version` IPC handler is slow or never replies (main-process stall), the first-run welcome window shows nothing — a transparent, frameless, undismissable window (per `welcome.html`'s `background: transparent`) — until the user force-closes it another way.
- **Fix:** Add a short timeout that falls back to a default version string (mirroring the existing `.catch` fallback), so the screen always renders within a bounded time.

---

### [P2] `StatusIndicator` is fully static — never reflects actual app state
- **Where:** `app/renderer/app/components/StatusIndicator.tsx:1-15`
- **What:** The component takes no props and reads no state; it unconditionally renders a green dot and the text "Ready".
- **Evidence:**
  ```tsx
  export default function StatusIndicator() {
    return (
      <div className="flex items-center gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
        <span className="text-green-600 font-medium">Ready</span>
      </div>
    );
  }
  ```
- **Impact:** There is no in-popup surface for recording/processing/error state — the popup's own status bar always claims "Ready" even while a transcription is processing or has just failed. All real status lives only in the native tray icon color (set from `CaptureApp` via `updateTrayState`), which the user isn't necessarily looking at while the popup has focus. This directly matches the "no error surface for failures" concern: e.g. `CaptureApp.tsx:396-398` flips the tray to `'error'` on a failed clipboard write, but a user with the popup open sees no change at all.
- **Fix:** Either wire `StatusIndicator` to the same tray-state IPC channel `CaptureApp` already updates, or remove it if the tray icon is considered sufficient, to avoid a misleading always-green indicator.

---

### [P2] One ~400-line `useEffect` owns six unrelated concerns
- **Where:** `app/renderer/app/CaptureApp.tsx:139-544`
- **What:** A single effect with an empty dependency array sets up: console.log/error/warn overriding + IPC forwarding, diagnostics wiring (`onTrackEvent`, `onCaptureReady`, devicechange listener), the global-shortcut toggle listener, the countdown interval, and the entire start/stop/retry/safety-timeout transcription state machine (`performStop`, `resetState`, `startCountdownInterval`, `clearCountdown` are all defined inline inside it).
- **Evidence:**
  ```tsx
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;
    // console.log/error/warn overrides ...
    // diagnostics wiring ...
    /** Clear countdown interval and notify popup */
    const clearCountdown = () => { /* ... */ };
    /** Start the 1-second countdown interval */
    const startCountdownInterval = () => { /* ... */ };
    /** Reset all state to known good — safety valve */
    const resetState = (electronAPI: any) => { /* ... */ };
    /** Shared stop logic — used by both manual stop and auto-stop */
    const performStop = async (electronAPI: any) => { /* ~180 lines */ };
    const unsubscribe = api.onGlobalShortcutToggle(() => { /* ~100 lines */ });
    return () => { /* teardown for all of the above */ };
  }, []);
  ```
- **Impact:** Any future change to one concern (e.g. diagnostics) risks breaking an unrelated one (e.g. the countdown timer) because they all share one closure and one cleanup path; the effect is also effectively untestable in isolation, and the single empty dependency array hides the fact that `initWebGpuOrchestrator` and other outer values are being closed over.
- **Fix:** Split into focused custom hooks (`useConsoleForwarding`, `useDiagnosticsWiring`, `useRecordingController`, `useCountdown`) each with its own effect and cleanup, composed in `CaptureApp`.

---

### [P2] `SettingsPanel` is destroyed (not hidden) whenever the recording countdown activates
- **Where:** `app/renderer/app/PopupApp.tsx:183-196`
- **What:** The content area swaps between `CountdownDisplay` and `<>...{showSettings && <SettingsPanel/>}</>` via a ternary keyed on `countdown?.active`. When a recording crosses the 9-minute warning threshold while Settings is open, `SettingsPanel` unmounts (React tears down the whole subtree), rather than being visually hidden.
- **Evidence:**
  ```tsx
  {countdown?.active ? (
    <CountdownDisplay remaining={countdown.remaining} />
  ) : (
    <>
      <TranscriptionDisplay
        text={transcription.text}
        processingTime={transcription.processingTime}
        onCopy={handleCopy}
      />
      {showSettings && <SettingsPanel />}
    </>
  )}
  ```
- **Impact:** If a user has Settings open during a long recording, once the 1-minute countdown warning appears, Settings force-closes and — because `SettingsPanel` re-fetches everything on mount (`cloud:get-config`, `engine:list-models`, `webgpu:check-availability`, `app-config:get`) — reopening it after the countdown clears re-runs every one of those IPC round-trips instead of resuming the already-loaded panel.
- **Fix:** Hide with CSS (`hidden`/conditional class) instead of conditional unmount, or lift the countdown display to overlay on top rather than replacing the content tree.

---

### [P3] Copy-feedback timeout is untracked and never cleared
- **Where:** `app/renderer/app/components/TranscriptionDisplay.tsx:12-17`
- **What:** `handleClick` starts a `setTimeout` to reset the "Copied!" badge but never stores the id or clears it on unmount or on a subsequent click.
- **Evidence:**
  ```tsx
  const handleClick = useCallback(() => {
    if (!text) return;
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text, onCopy]);
  ```
- **Impact:** Rapid re-clicks stack multiple pending timers (harmless but wasteful); if the popup window is hidden/closed inside the 1.5s window, `setCopied` still fires against an unmounted component.
- **Fix:** Store the timer in a `useRef`, clear any existing one before starting a new one, and clear it in a `useEffect` cleanup on unmount.

---

### [P3] `AudioCapture`/`InferenceOrchestrator` are constructed inside the `useRef` initializer expression
- **Where:** `app/renderer/app/CaptureApp.tsx:35`, `:43`
- **What:** `useRef(new AudioCapture())` and `useRef(new InferenceOrchestrator())` evaluate `new AudioCapture()`/`new InferenceOrchestrator()` on every render of `CaptureApp` (React only keeps the *result* on the first render — the constructor call itself still runs every time, and the extra instance is discarded).
- **Evidence:**
  ```tsx
  const audioCapture = useRef(new AudioCapture());
  // ...
  const orchestratorRef = useRef<InferenceOrchestrator>(new InferenceOrchestrator());
  ```
- **Impact:** Currently low — `CaptureApp` calls no `useState`, so it never re-renders after mount in production, meaning this only bites twice under dev `React.StrictMode` double-invoke. It becomes a real perf/correctness trap the moment any state is added to this component (each re-render would construct-then-discard a fresh `AudioCapture`/`InferenceOrchestrator`).
- **Fix:** Use `useRef<AudioCapture | null>(null)` with lazy assignment (`if (!ref.current) ref.current = new AudioCapture()`), or `useState(() => new AudioCapture())[0]`.

---

### [P3] Inline array literal recreated every render for mic-hold duration options
- **Where:** `app/renderer/app/components/SettingsPanel.tsx:552-560`
- **What:** The list of hold-duration options is a new array/object literal constructed inline in JSX on every render of `SettingsPanel`.
- **Evidence:**
  ```tsx
  {([
    { label: '30s', ms: 30000 },
    { label: '1m',  ms: 60000 },
    { label: '2m',  ms: 120000 },
    { label: '5m',  ms: 300000 },
    { label: '10m', ms: 600000 },
    { label: '30m', ms: 1800000 },
    { label: '1h',  ms: 3600000 },
  ] as const).map(({ label, ms }) => (
  ```
- **Impact:** Negligible today (7 static items, low-frequency component), but it's exactly the "new array/object identity each render" pattern the review flags — worth hoisting so it doesn't get copy-pasted into a hotter path later.
- **Fix:** Hoist to a module-level `const MIC_HOLD_OPTIONS = [...] as const` outside the component.

---

## Architecture assessment

- **Three independent React roots with no shared state layer.** `main.tsx` (headless `CaptureApp`), `popup-main.tsx` (`PopupApp`), and `welcome-main.tsx` (`WelcomeApp`) each independently call the same IPC getters (`cloud:get-config`, `app-config:get`) and cache the results locally (refs in `CaptureApp`, `useState` in `SettingsPanel`). There is no broadcast/subscribe mechanism when one window changes config — see the P1 model-desync finding above for a concrete consequence.
- **`CaptureApp` carries zero React state and is really a plain controller wearing a React component.** All logic lives in refs and one giant effect (`CaptureApp.tsx:139-544`); React buys this window almost nothing beyond mount/unmount timing. A plain module exposing `init()`/`dispose()` would be more legible and unit-testable than a 400-line effect closure.
- **Two different persistence strategies coexist in `SettingsPanel`.** Model switching is optimistic-and-confirmed (`setModels` updates immediately, then reconciles from `engine:switch-model`'s result), while endpoint/API-key persistence is a blind "save on every render where the value changed" effect with no debounce. Inconsistent sync strategy within a single component increases the chance the next feature added copies the weaker pattern.
- **No shared status between the tray/`CaptureApp` and the popup UI.** `updateTrayState` is the only channel that carries recording/processing/error/done state, and `StatusIndicator` in the popup never consumes it — the popup can visually disagree with the actual state (always shows "Ready").
- **Conditional-mount is used where conditional-hide was needed.** `PopupApp.tsx`'s countdown-vs-content ternary tears down `SettingsPanel` (and its 4 IPC fetch effects) any time recording crosses the countdown threshold, coupling an unrelated timer event to Settings' mount lifecycle.
