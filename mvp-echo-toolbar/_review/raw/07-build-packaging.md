# 07 — Build, Packaging, Distribution & Startup Cost

Scope: `mvp-echo-toolbar/package.json` (canonical build config), outer `package.json`, Vite/TS configs,
`.github/workflows/*.yml`, `.gitignore`/`.dev-only`, `app/main/main-simple.js` asset-loading paths, and a
direct inspection of a locally-produced `dist/` build (electron-builder v26, portable Windows target).

## What actually ships

Measured from `mvp-echo-toolbar/dist/` (a local `npm run dist` output, portable Windows target) and
`npx asar list dist/win-unpacked/resources/app.asar`. Sizes are `du -sh` / `ls -la` on-disk measurements.

| Item | Source path | Measured size | Referenced by code? |
|---|---|---|---|
| Final downloadable artifact | `dist/MVP-Echo Toolbar 3.0.27.exe` | 290,514,196 bytes (277 MiB / 290.5 MB) | N/A — this is the release asset |
| Uncompressed install footprint | `dist/win-unpacked/` | 974 MB total | N/A |
| `resources/app.asar` | `dist/win-unpacked/resources/app.asar` | 417 MB | Partially — see breakdown below |
| `resources/sherpa-onnx-bin/` (incl. `ffmpeg.exe` 169.9 MB) | extraResources ← `sherpa-onnx-bin/` | 180 MB | Yes — `engine-manager.js`, `local-model-manager.js` |
| `resources/sherpa_onnx_models/…110m-en-int8/` | extraResources ← `sherpa_onnx_models/…` (symlink) | 126 MB | Yes — `local-model-manager.js` (`model.int8.onnx` + `tokens.txt`, no extra files) |
| `MVP-Echo Toolbar.exe` (Electron/Chromium runtime) | electron prebuilt | 169 MB | Yes (the app shell itself) |
| `locales/` | electron prebuilt | 37 MB | Partial — Electron ships all Chromium locale `.pak` files; app is English-only UI |
| **Inside app.asar:** `/node_modules/parakeet.js/node_modules/onnxruntime-web` + `onnxruntime-common` | `node_modules/**/*` glob (no exclusions) | 134 MB | **No** — see [P1] finding below; renderer uses its own separately-bundled copy |
| **Inside app.asar:** `/dist/win-unpacked/…/electron.exe` + locales (nested prior build output) | `dist/**/*` glob (no exclusions) | ~53 entries incl. a full `electron.exe`, chromium `.pak`/`.dll`/locale files | **No** — stale, self-referential packaging artifact, see [P0] finding |
| `/dist/renderer/*` (actual Vite build: React bundle + `ort-wasm-simd-threaded.jsep.wasm`) | `dist/**/*` glob | 25 MB | Yes — loaded via `loadFile()` in `main-simple.js` |
| `resources/stt/` (duplicate copy of `app/stt/`) | `extraFiles` ← `app/stt` | 96 KB | **No** — nothing reads `process.resourcesPath + 'stt'` |
| `resources/elevate.exe` | electron-builder built-in (NSIS elevate helper) | 108 KB | Yes (portable/NSIS internal) |
| `ffmpeg-essentials.zip` + `ffmpeg-master-latest-win64-lgpl/` (repo root, gitignored) | not referenced by `files`/`extraResources` at all | 195 MB + 525 MB = 720 MB on disk | **No** — local dev scratch only, does not ship |

## Findings

### [P0] `files: ["dist/**/*"]` is self-referential with `directories.output: "dist"` — a prior build's electron.exe got packed inside the current app.asar
- **Where:** `mvp-echo-toolbar/package.json:20-25` (`build.files`) and `:16-18` (`build.directories.output`)
- **What:** electron-builder's output directory (`dist/win-unpacked`, the produced `.exe`) is the *same* directory that `"dist/**/*"` in `files` treats as *input* to the app.asar. Nothing excludes the packager's own prior output. On this machine's `dist/`, `app.asar` was found to contain a full nested `/dist/win-unpacked/` tree — including a second `electron.exe`, Chromium `.pak` files, and all locale `.pak` files — from an earlier, uncleaned build.
- **Evidence:**
  ```
  $ npx asar list dist/win-unpacked/resources/app.asar | grep '^/dist/win-unpacked' | head
  /dist/win-unpacked
  /dist/win-unpacked/LICENSE.electron.txt
  /dist/win-unpacked/LICENSES.chromium.html
  /dist/win-unpacked/chrome_100_percent.pak
  /dist/win-unpacked/chrome_200_percent.pak
  /dist/win-unpacked/d3dcompiler_47.dll
  /dist/win-unpacked/electron.exe
  /dist/win-unpacked/ffmpeg.dll
  /dist/win-unpacked/icudtl.dat
  ... (73 entries total under /dist/win-unpacked)
  ```
  `package.json:12`: `"dist": "npm run clean && npm run build && electron-builder --win --publish=never"` — the `clean` step (`rm -rf dist`) only runs when the packager is invoked through this exact npm script. Any direct `electron-builder`/`npx electron-builder` invocation (a very normal thing to do to skip re-running Vite) skips `clean` entirely and will reproduce this.
- **Impact:** This app.asar (417 MB) is carrying a full stale Electron runtime inside itself. It roughly explains the bulk of the asar's size (134 MB dead `onnxruntime-web` copy + this nested `dist/win-unpacked`, together accounting for most of 417 MB against ~25 MB of actual renderer payload). If this happens on a build that gets released, users download tens to hundreds of extra MB, and successive un-cleaned builds compound (each pass can re-embed the previous one).
- **Fix:** Add explicit negations to `files` (`"!dist/win-unpacked/**"`, `"!dist/*.exe"`, `"!dist/*.blockmap"`, `"!dist/builder-*.yml"`) so the packager's own output directory can never be treated as packaging input, regardless of invocation path. Alternatively, point `directories.output` at a directory outside anything matched by `files` (e.g. `release/` instead of `dist/`), which removes the self-reference structurally. UNVERIFIED whether the actual GitHub Actions–built release artifacts are affected — CI does a fresh `actions/checkout` each run so `dist/` doesn't pre-exist, but there is currently no glob-level guard, so a retry-in-place or any future workflow change (e.g. build caching) would silently reproduce this. Confirm by extracting a released `.exe` (`asar list` its `resources/app.asar`) and checking for a `/dist/win-unpacked` entry.

### [P1] `parakeet.js` (with `onnxruntime-web`) ships as a raw, unused copy inside app.asar — ~134 MB of dead weight
- **Where:** `mvp-echo-toolbar/package.json:34` (`"parakeet.js": "^1.4.4"` in `dependencies`) and `:20-25` (`build.files` includes `"node_modules/**/*"` with no exclusion)
- **What:** `parakeet.js` is listed as a production dependency, so electron-builder's default prod-dependency filtering keeps it (and its own nested `node_modules`) inside `app.asar`. But `parakeet.js` is only ever imported from the **renderer**, which Vite already bundles into `dist/renderer/assets/` (its own 402 KB `ort.bundle.min-*.js` + 24.9 MB `ort-wasm-simd-threaded.jsep-*.wasm`). No main-process file ever does `require('parakeet.js')` — only comments reference it.
  ```
  $ grep -rn "from 'parakeet.js'\|require('parakeet" app/ --include=*.js --include=*.ts --include=*.tsx
  app/renderer/app/webgpu/inference-worker.ts:16:import { fromHub } from 'parakeet.js';
  ```
  (Only hit; it's a renderer `.ts` file, compiled away by Vite — the raw npm package is never loaded at runtime.)
- **Evidence:**
  ```
  $ npx asar list dist/win-unpacked/resources/app.asar | grep -oP '(?<=/node_modules/)[^/]+' | sort -u
  ... onnxruntime-common onnxruntime-web parakeet.js ...

  $ du -sh node_modules/parakeet.js/node_modules/*/
  133M	node_modules/parakeet.js/node_modules/onnxruntime-web/
  1.2M	node_modules/parakeet.js/node_modules/onnxruntime-common/

  $ ls -la node_modules/parakeet.js/node_modules/onnxruntime-web/dist/*.wasm
  16796269  ort-wasm-simd-threaded.jspi.wasm
  12297086  ort-wasm-simd-threaded.wasm
  24911187  ort-wasm-simd-threaded.jsep.wasm
  27084114  ort-wasm-simd-threaded.asyncify.wasm
  ```
- **Impact:** ~134 MB of the 417 MB app.asar (32%) is a completely unused duplicate onnxruntime-web install (4 separate wasm variants) that never executes — the app already ships a working copy of the one wasm variant it needs via `dist/renderer/`. This directly inflates both the unpacked footprint and the compressed download.
- **Fix:** Move `parakeet.js` to `devDependencies` (it's a build-time/renderer-bundle-time dependency only, consumed by Vite, never by the packaged main process) or add `"!node_modules/parakeet.js/**"` to `files` if it must stay a runtime dependency for some other reason. Either removes it from the asar entirely.

### [P1] Full "essentials" ffmpeg.exe (169.9 MB) bundled for a single WebM→WAV conversion
- **Where:** `mvp-echo-toolbar/package.json:26-32` (`extraResources` → `sherpa-onnx-bin`), used from `app/stt/engine-manager.js:582-643`
- **What:** `sherpa-onnx-bin/ffmpeg.exe` is a full multimedia ffmpeg build (video codecs, filters, muxers/demuxers for formats the app never touches) used for exactly one job: converting recorded WebM audio to 16kHz mono WAV before handing it to the local STT engine.
  ```
  app/stt/engine-manager.js:582:   * Find ffmpeg.exe in the bundle.
  app/stt/engine-manager.js:587:      path.join(process.resourcesPath || '', 'sherpa-onnx-bin', 'ffmpeg.exe'),
  app/stt/engine-manager.js:603:    const ffmpegPath = this._getFfmpegPath();
  app/stt/engine-manager.js:620:      const child = spawn(ffmpegPath, args, { ... });
  ```
  Source confirmed via the repo-root scratch files: `ffmpeg-essentials.zip` unpacks to `ffmpeg-master-latest-win64-lgpl/bin/ffmpeg.exe` at 169,901,568 bytes — an exact byte match to the shipped `sherpa-onnx-bin/ffmpeg.exe`.
- **Evidence:**
  ```
  $ ls -la sherpa-onnx-bin/ffmpeg.exe
  -rwxr-xr-x 1 corey corey 169901568 ... ffmpeg.exe

  $ unzip -l ffmpeg-essentials.zip | grep bin/ffmpeg.exe
  169901568  ffmpeg-master-latest-win64-lgpl/bin/ffmpeg.exe
  ```
- **Impact:** This single binary is 169.9 MB of the 180 MB `sherpa-onnx-bin` resource directory, and by itself is roughly 61% of the compressed 278 MiB download. A minimal audio-only ffmpeg build (PCM/WAV/WebM/Opus/Vorbis decode+encode, no libx264/libvpx/video filters) is typically 5-20 MB.
- **Fix:** Build or source a stripped ffmpeg (e.g. `--disable-everything` with only the needed demuxers/decoders/muxer enabled), or replace the ffmpeg dependency entirely with a pure-JS/WASM WebM→PCM decode path already available in the app (it already ships an onnxruntime-web/WASM pipeline for the WebGPU engine) to drop the native binary altogether.

### [P1] App ships fully unsigned (`forceCodeSigning: false`, no certificate) — Windows SmartScreen will warn every user
- **Where:** `mvp-echo-toolbar/package.json:33-40` (`build.win`)
- **What:**
  ```
  "win": {
    "target": [ { "target": "portable", "arch": [ "x64" ] } ],
    "verifyUpdateCodeSignature": false,
    "forceCodeSigning": false
  }
  ```
  No `certificateFile`/`certificatePassword`/`CSC_LINK` is configured anywhere in the repo or workflows, and `build-electron-app.yml:54` sets `CSC_IDENTITY_AUTO_DISCOVERY: false`.
- **Impact:** Every user who downloads and runs the portable `.exe` from GitHub Releases will hit an unsigned-binary SmartScreen "Windows protected your PC" prompt, which is a significant adoption/trust barrier for a consumer-facing tool distributed outside a store.
- **Fix:** This may be an accepted tradeoff for a free/indie tool (EV code-signing certs are expensive), but it should be a conscious decision, not a silent default — document it in the release runbook, or budget for an OV/EV cert (or Azure Trusted Signing, which is much cheaper) if user-reported "SmartScreen scared me off" is or becomes a problem.

### [P1] CI installs dependencies with `npm install` against a gitignored lockfile — build is not reproducible
- **Where:** `.github/workflows/build-electron-app.yml:45-46`; `.gitignore:50`
- **What:** The build workflow runs `npm install` (not `npm ci`). `package-lock.json` exists on disk in both `mvp-echo-toolbar/` and the outer repo but is excluded from git by a repo-root `.gitignore` pattern that applies at every directory level.
  ```
  build-electron-app.yml:45:    - name: Install Node dependencies
  build-electron-app.yml:46:      run: npm install

  $ git check-ignore -v mvp-echo-toolbar/package-lock.json
  .gitignore:50:package-lock.json	mvp-echo-toolbar/package-lock.json

  $ git ls-files | grep -c package-lock.json
  0
  ```
- **Impact:** Every CI run resolves the dependency tree fresh from whatever the registry currently serves for the floating ranges in `package.json` (e.g. `"electron": "^28.0.0"`, `"electron-builder": "^26.0.12"`, `"vite": "^5.0.12"`). This is the exact mechanism that already broke a release once (per project history: `@noble/hashes` 2.x drift in 3.0.23, worked around with an `overrides` pin). The `overrides` pin only protects that one transitive package — nothing protects the rest of the tree from drifting between a developer's local build and the CI-built release artifact, or between two different CI runs.
- **Fix:** Commit `package-lock.json` (remove the two `package-lock.json` lines from `.gitignore`) and switch the workflow to `npm ci`. This is called out as already-known/deferred work in the project's CLAUDE.md — confirmed still unresolved as of this review.

### [P2] No type-checking, linting, or test gate anywhere in the pipeline
- **Where:** `mvp-echo-toolbar/package.json:7-15` (`scripts`); `.github/workflows/build-electron-app.yml` (full file); `.github/workflows/clean-release.yml` (full file)
- **What:** `"test": "echo \"No tests yet\""` (`package.json:14`) is the only test-related script and it is never invoked by either workflow. There is no `typecheck`/`tsc` script at all. `tsconfig.json:11` sets `"noEmit": true`, meaning the only way type errors would ever surface is by someone manually running `tsc -b` — Vite's `build` (`vite build`, used both locally and in CI at `build-electron-app.yml:48-49`) uses esbuild for transpilation only and does not type-check. `vite.config.ts:35` plugin list (`[react(), serveModelFiles()]`) has no `vite-plugin-checker` or equivalent.
- **Evidence:**
  ```
  $ grep -n '"scripts"' -A 10 package.json
    "scripts": {
      "dev": "...",
      "build": "vite build",
      "clean": "rm -rf dist",
      "dist": "npm run clean && npm run build && electron-builder --win --publish=never",
      "start": "electron .",
      "test": "echo \"No tests yet\""
    },
  ```
- **Impact:** A type error, broken import, or runtime-only logic bug in `app/renderer` or `app/main` can reach a tagged release with zero automated signal — the first person to find it is a user. Combined with the CI's only "verification" step being `dir dist` (a directory listing, not a smoke test — `build-electron-app.yml:57-59`), there is no automated check that the produced `.exe` even launches.
- **Fix:** Add a `"typecheck": "tsc -b"` script and run it as a required CI step before `electron-builder` packaging; at minimum this catches broken imports/type drift before a multi-hundred-MB artifact is built and released.

### [P2] `resources/stt` is a dead duplicate of `app/stt` (already shipped inside app.asar)
- **Where:** `mvp-echo-toolbar/package.json:19-22` (`extraFiles`)
- **What:** `extraFiles` copies `app/stt` to `resources/stt` *outside* the asar, in addition to `app/stt` already being included inside `app.asar` via the `"app/**/*"` entry in `files`. No code references `process.resourcesPath` joined with `'stt'` or `'resources/stt'` anywhere.
  ```
  $ grep -rn "resourcesPath.*stt\|'stt'\|\"stt\"" app/ --include=*.js
  (no matches)
  ```
  `app/stt/engine-manager.js` is loaded the normal way, from inside the asar:
  ```
  app/main/main-simple.js:6:const { EngineManager } = require('../stt/engine-manager');
  ```
- **Impact:** Minor (96 KB) but it's dead config — a maintainer could reasonably assume `resources/stt` is load-bearing (e.g. for some unpacked-native-module reason) and be surprised it isn't.
- **Fix:** Remove the `extraFiles` entry for `app/stt` unless there's a concrete reason (e.g. a future native addon there needs to be unpacked) — if so, document it inline.

### [P2] `NODE_ENV === 'development'` gates dev-vs-prod asset loading instead of `app.isPackaged`
- **Where:** `mvp-echo-toolbar/app/main/main-simple.js:149-154`, `:216-220`, `:326-330`
- **What:** All three windows (hidden capture window, popup, welcome) choose between `loadURL('http://localhost:5175/...')` and `loadFile(path.join(__dirname, '../../dist/renderer/...'))` based on `process.env.NODE_ENV === 'development'`.
  ```
  149:  if (process.env.NODE_ENV === 'development') {
  150:    hiddenWindow.loadURL('http://localhost:5175/index.html');
  151:  } else {
  152:    const htmlPath = path.join(__dirname, '../../dist/renderer/index.html');
  153:    hiddenWindow.loadFile(htmlPath);
  ```
- **Impact:** `NODE_ENV` is an inherited environment variable, not an Electron-verified packaging signal. On a machine where `NODE_ENV=development` is set globally (common on dev workstations, some shells' profile scripts, or containers), launching the *packaged* portable `.exe` would try to reach `localhost:5175` and load nothing — a blank/broken window with no error surfaced to the user. This is a plausible-but-uncommon footgun, not a confirmed field failure.
- **Fix:** Gate on `app.isPackaged` instead (or in addition), which reflects actual packaging state rather than an inheritable env var.

### [P3] Electron ships all ~55 Chromium locale `.pak` files (37 MB) for an English-only UI
- **Where:** electron-builder default behavior; no `electronLanguages` restriction configured in `mvp-echo-toolbar/package.json` `build.win`/top-level `build`.
- **Evidence:**
  ```
  $ du -sh dist/win-unpacked/locales/
  37M	dist/win-unpacked/locales/
  ```
- **Impact:** ~37 MB of the unpacked footprint is Chromium UI-chrome translations the app's UI never surfaces (it's a single-purpose toolbar with no localized strings observed in `SettingsPanel.tsx` etc.).
- **Fix:** electron-builder supports trimming shipped locales (e.g. via `electronLanguages: ["en-US"]` in the `build` config, or a post-pack prune step) if the app is English-only by design.

### [P3] CI workflow requests `permissions: contents: write` for a job that only reads a release asset
- **Where:** `.github/workflows/build-electron-app.yml:6-7`
- **What:** The workflow's only GitHub-side operation is `gh release download build-deps-v0.0.0` (`:24-27`), which needs read access, not write. `permissions: contents: write` is broader than the job requires.
- **Impact:** Low — reduces defense-in-depth; if the workflow or an injected step were ever compromised (e.g. via a malicious dependency's install script, since `npm install` runs before this permission window closes), it would have push/release-write capability it doesn't need.
- **Fix:** Scope to `contents: read` unless a later step needs write (it doesn't — the upload-artifact step doesn't require `contents: write`).

### [P3] `build-deps-v0.0.0` GitHub Release is CI's sole, unversioned source for `sherpa-onnx-bin`/model — drift risk vs. local dev copies
- **Where:** `.github/workflows/build-electron-app.yml:20-38`
- **What:** CI reconstructs `sherpa-onnx-bin/` and `sherpa_onnx_models/…110m…` from a fixed tag `build-deps-v0.0.0` release asset (`mvp-echo-build-deps.zip`), entirely decoupled from git history. The local on-disk copies (`sherpa-onnx-bin/`, `sherpa_onnx_models/`) are gitignored (confirmed via `.gitignore` patterns) so there is no way to diff "what's in the release asset" against "what's on a developer's machine" from git alone.
- **Impact:** UNVERIFIED whether the release asset is currently in sync with the local binaries measured in this review (169.9 MB ffmpeg.exe, 1.8 MB sherpa-onnx-c-api.dll, etc.) — would require downloading `build-deps-v0.0.0` and diffing. If a maintainer updates the local `sherpa-onnx-bin` (e.g. a sherpa-onnx version bump) without re-uploading to this release tag, CI silently keeps building with the stale binary and no error is raised.
- **Fix:** Version the build-deps release tag alongside app releases (or store a checksum manifest in-repo that CI verifies against the downloaded zip) so drift is detectable.

## Architecture assessment

- **The build's `files` glob is unsafe by construction.** `directories.output: "dist"` and `files: ["dist/**/*", ...]` reference the same path with no exclusions, so the packager's own output can become its own input. This was directly observed on disk (a full nested `electron.exe` + Chromium runtime inside `app.asar`) and is the single largest unforced contributor to artifact bloat found in this review — worse than the intentional-but-oversized binaries (ffmpeg, sherpa model), because it's unbounded and can compound across successive un-cleaned builds.
- **Production `dependencies` vs. renderer-bundled code are not distinguished.** `parakeet.js` sits in `dependencies` (so electron-builder ships it raw in `app.asar`) purely because it's *imported* somewhere in the renderer source tree — but the renderer is a Vite-bundled artifact that already carries its own copy of everything it needs. Nothing in the build enforces "only main-process `require()`-able code belongs in `dependencies`"; it's an easy trap for any future renderer-only library added without moving it to `devDependencies`.
- **Reproducibility has a known gap that's still open.** `package-lock.json` exists locally (twice — once per project level) but is gitignored at the repo root, and CI still runs `npm install`. This is documented in the project's own CLAUDE.md as previously-diagnosed (the `@noble/hashes` incident) and explicitly deferred — it is confirmed still unresolved as of this review, not just historical.
- **No safety net between "code compiles" and "artifact is released."** No `tsc` run anywhere (Vite doesn't type-check), no test execution (`npm test` is a no-op and is never even invoked by CI), and the only CI "verification" of the built `.exe` is `dir dist` — a directory listing. A broken build can flow straight through both manual pipeline steps (build workflow → `gh release create`) with no automated gate catching it.
- **Distribution trust is unaddressed.** The artifact is fully unsigned (`forceCodeSigning: false`, no certificate configured), so every user hits a Windows SmartScreen warning — a real adoption cost for a tool distributed outside a store, and not currently flagged as a conscious tradeoff anywhere in the docs reviewed.
- **External binary dependencies (ffmpeg, sherpa) are oversized for their actual job**, and the mechanism that supplies them to CI (a fixed, unversioned `build-deps-v0.0.0` GitHub Release) is disconnected from git history, so there's no way to audit or diff what CI actually bundles against what's on a developer's disk.
