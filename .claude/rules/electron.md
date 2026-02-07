# Electron Main Process Rules

**Applies to**: `app/main/`

## Patterns

- Use CommonJS (`require`) in main process files
- Entry point is `main-simple.js` for production
- `main.ts` is for development/TypeScript reference

## IPC Guidelines

- All IPC handlers in `main-simple.js`
- Use `ipcMain.handle()` for async operations
- Always return structured responses: `{ success, data, error }`

## Security

- Never expose Node.js APIs directly to renderer
- All filesystem access through main process
- Validate all IPC inputs

## Engine Management

- `engine-manager.js` coordinates STT engines
- Always implement fallback logic
- Save user preferences to `engine-config.json`

## Process Lifecycle

- Handle `app.on('window-all-closed')` for cleanup
- Clean temp files before exit
- Gracefully shutdown Python subprocesses
