# Agentic Coding VS Code Extension — TODO

## Phase 0 — Bootstrap (Streaming-First)

- [x] Create extension scaffold (TypeScript)
- [x] Add a webview view (sidebar) contributed via `agentic.openPanel` command
- [x] Implement UI layout
  - [x] Multiline `<textarea>` prompt input
  - [x] Attached files list
  - [x] "Attach files" button
  - [x] "New session" button
  - [x] "Send" button
  - [x] "Stop" button (cancel generation)
  - [x] Output area that renders Markdown
- [x] Implement OpenAI-compatible streaming client
  - [x] `POST /chat/completions` with `stream: true`
  - [x] Parse SSE `data:` frames, append `delta.content` as it arrives
  - [x] Handle `[DONE]`, errors, and reconnect-safe cleanup
  - [x] `AbortController` to cancel generation
- [x] Hardcode initial model settings (endpoint, model, context)

## Phase 1 — File Attach + Workspace Read

- [x] Attach flow using `vscode.window.showOpenDialog`
- [x] Restrict file selection to inside the workspace
- [x] Read file contents via `vscode.workspace.fs.readFile`
- [x] Store attachments: `uri`, `relativePath`, `languageId`, `content`, `sizeBytes`
- [x] Per-file content cap (e.g., 200–400 KB)
- [x] Total attached content cap (e.g., 1–2 MB)
- [x] Truncate oversized files with clear labeling

## Phase 2 — Write Files (Apply Patches Safely)

- [x] Define and document the `@@EDIT` structured edit block format
- [x] Implement edit block parser in extension host
- [x] Validate target path is inside the workspace
- [x] Validate `FROM` text exists (exact match); fail safely if not
- [x] Show diff via VS Code diff API before applying
- [x] Require explicit user approval (Apply / Cancel) before writing
- [x] Apply edits via `vscode.workspace.fs.writeFile`

## Phase 3 — Sessions (Multi-Turn Memory)

- [x] Define session schema: `sessionId`, `title`, `createdAt`, message list, attachments
- [x] Choose persistence strategy (workspaceState / globalState / JSON file)
- [x] Implement "New session" button: creates session, clears output
- [x] Persist and restore last session across VS Code restarts

## Phase 4 — Terminal Commands and File Ops with Approvals

- [x] Implement `run_command` tool with approval gate
- [x] Implement `move_file` tool with approval gate
- [x] Implement `delete_file` tool with approval gate (prefer trash)
- [x] Implement approval card UI in webview
  - [x] Show action type, target, reason, and preview
  - [x] **Approve** / **Deny** buttons (default focus: Deny)
  - [x] Optional "Approve & Don't ask again for this session" for non-destructive actions
- [x] Implement approval protocol: `approval/request` → `approval/response` message bridge
- [x] Maintain `Map<approvalId, resolver>` in AgentRunner
- [x] Execute terminal commands via `child_process.spawn/exec` with capped output
- [x] Feed action results back to the model as a compact summary

## Phase 5 — Better Streaming UX (Post-MVP)

- [x] Buffer text deltas and re-render Markdown on a timer (~100ms)
- [x] Sanitize rendered HTML with DOMPurify
- [x] Add token/throughput stats display (if server returns usage)
- [x] Resilient cancellation + cleanup ("Cancelled" vs "Completed" states)
- [x] Backpressure handling when webview is hidden
- [x] "Copy raw" and "Copy markdown" actions
- [ ] Quick-pick for sessions
- [ ] File tree picker (replace open dialog)
- [ ] Auto-attach active editor / selection ("context builder")

---

## Extension Host Checklist

- [ ] Commands: `agentic.openPanel`, `agentic.newSession`, `agentic.attachFiles`
- [ ] Webview panel + message bridge (`messageProtocol.ts`)
- [ ] LLM client — OpenAI-compatible with streaming (`OpenAIProvider.ts`)
- [ ] Workspace file read (`FileTools.ts`)
- [ ] Edit parser + diff preview + write (`editParser.ts`)
- [ ] Session storage (`ConfigManager.ts` / state)
- [ ] Terminal command approval + execution (`TerminalTool.ts`)
- [ ] Workspace boundary checks (never read/write outside workspace)
- [ ] Content caps (truncate attachments and terminal output)

## Webview UI Checklist

- [ ] Textarea prompt
- [ ] Attach files button + attached files list
- [ ] New session button
- [ ] Send button
- [ ] Stop button
- [ ] Markdown renderer (`marked` + DOMPurify)
- [ ] Status/error display
- [ ] Approval card UI (action type, target, reason, preview, Approve/Deny)

---

## Build & Tooling

- [ ] Set up `package.json` with extension manifest and scripts
- [ ] Set up `tsconfig.json`
- [ ] Configure esbuild with two bundles:
  - [ ] Extension host: `src/extension.ts` → `dist/extension.js` (Node/CJS, external: `vscode`)
  - [ ] Webview: `webview-ui/main.ts` → `dist/webview.js` (browser)
- [ ] Scripts: `build`, `watch`, `typecheck`, `vscode:prepublish`
- [ ] `.vscodeignore` and `.gitignore`
- [ ] VS Code settings schema under `agentCoder.*`:
  - [ ] `agentCoder.baseUrl`
  - [ ] `agentCoder.model`
  - [ ] `agentCoder.maxContextTokens`
  - [ ] `agentCoder.provider`
  - [ ] API key storage via `context.secrets`

## Testing

- [ ] Set up a small demo repo for manual testing
- [ ] Unit tests for edit block parser
- [ ] Unit tests for command JSON extraction
- [ ] Manual: attach file → ask for explanation
- [ ] Manual: ask for small edit → preview diff → apply
- [ ] Manual: ask to run tests → approve command
