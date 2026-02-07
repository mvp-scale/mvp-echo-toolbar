# React/Renderer Rules

**Applies to**: `app/renderer/`

## Component Patterns

- Functional components with hooks only
- Keep components focused and small
- Colocate styles in component or use Tailwind

## Styling

- Use Tailwind CSS classes
- MVP Scale design system colors:
  - Primary: `oklch(0.55 0.25 264)` (electric blue)
  - Background: Dark theme default
- No inline styles unless dynamic

## State Management

- Use React hooks (`useState`, `useEffect`)
- No external state library needed
- IPC state via custom hooks

## IPC Communication

- Access via `window.electron` (from preload)
- Use async/await for IPC calls
- Handle loading and error states

## Audio Handling

- MediaRecorder API for capture
- WebM format for recording
- Send ArrayBuffer to main process via IPC

## Accessibility

- Keyboard shortcuts: Ctrl+Alt+Z for record
- Visual feedback for all actions
- Status messages in StatusBar
