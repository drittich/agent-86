# Agentic Coding VS Code Extension (Local LLM) — Build Plan

## Goals
Build a sideloaded VS Code extension for **Windows 11** that provides a simple agentic coding workflow using a **local OpenAI-compatible endpoint** (no MCP for now):

- Read/write files in the current workspace.
- Optional: run terminal commands **only with explicit user approval**.
- Simple UI:
  - Multiline prompt input
  - Attach one or more project files
  - Create a new session
  - Output window that renders **Markdown** returned by the model

### LLM connection (initial)
- Endpoint: `http://127.0.0.1:8083/v1`
- Model: `OpenAI-20B-NEO-CODEPlus-Uncensored-IQ4_NL.gguf`
- Context: `16384`

---

## Architecture Overview
Use a standard split:

1. **Extension Host (Node/TypeScript)**
   - Owns all privileged operations (file system, terminal, workspace state)
   - Communicates with the UI through message passing

2. **Webview UI (WebviewViewProvider in the Sidebar)**
   - Renders the chat/session UI
   - Sends user actions (prompt, attach file, new session)
   - Receives markdown output (and status) from extension host

3. **Agent Runner (agentic loop in extension host)**
   - Builds model input (prompt + attached files + limited context)
   - Calls the provider with streaming enabled (later) and emits deltas to UI
   - Executes tool calls (read/write/list/run) with explicit approval gates

---

## Proposed Project Structure

```
vscode-agent-extension/
├── package.json
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── .gitignore
│
├── src/
│   ├── extension.ts              # activate() / deactivate()
│   ├── agent/
│   │   ├── AgentRunner.ts        # Core agentic loop
│   │   ├── toolDefinitions.ts    # OpenAI tool schemas
│   │   └── toolExecutor.ts       # Tool dispatch table
│   ├── providers/
│   │   ├── IProvider.ts          # Common interface (stream, config)
│   │   ├── OpenAIProvider.ts     # openai SDK, custom baseURL
│   │   └── AnthropicProvider.ts  # optional future
│   ├── tools/
│   │   ├── FileTools.ts          # read_file, write_file, list_directory
│   │   └── TerminalTool.ts       # run_command with approval gate
│   ├── chat/
│   │   ├── ChatPanel.ts          # WebviewViewProvider
│   │   └── messageProtocol.ts    # Typed extension<->webview messages
│   └── config/
│       └── ConfigManager.ts      # workspace config + secrets
│
└── webview-ui/
    ├── index.html
    ├── main.ts                   # Webview-side TypeScript
    └── tsconfig.json
```

---

## Provider Abstraction
Keep a thin provider layer so you can swap local OpenAI-compatible servers or add Anthropic later.

**Interface sketch**

- Messages: `{ role: 'system'|'user'|'assistant'|'tool', content: string, tool_call_id?: string }`
- Provider returns an async stream of events: text deltas, tool calls, done.

**OpenAI-compatible provider**
- Use the `openai` npm package with:
  - `baseURL` set to your local endpoint
  - `apiKey: 'local'` (local servers typically ignore it)
- **Implement streaming from day 1** using `stream: true`.
  - Parse Server-Sent Events (SSE) chunks from `/chat/completions`.
  - Emit incremental text deltas to the webview so the output updates continuously.
  - Support `AbortController` so the user can cancel generation immediately.

---

## Config Defaults
Define VS Code settings under something like `agentCoder.*`:

- `agentCoder.baseUrl` (default `http://127.0.0.1:8083/v1`)
- `agentCoder.model` (default `OpenAI-20B-NEO-CODEPlus-Uncensored-IQ4_NL.gguf`)
- `agentCoder.maxContextTokens` (default `16384`)
- `agentCoder.provider` (`openai-compatible` | `anthropic`)
- API keys stored in `context.secrets` (even if local doesn’t need it, keeps the interface consistent)

---

## Tooling & Guardrails (implementation details)

### Tools to implement first
- `read_file` → `vscode.workspace.fs.readFile()`
- `write_file` → `vscode.workspace.fs.writeFile()`
- `list_directory` → `vscode.workspace.fs.readDirectory()`
- `move_file` → `vscode.workspace.fs.rename()` (approval gate)
- `delete_file` → `vscode.workspace.fs.delete()` (approval gate)
- `run_command` → approval gate → execute

### Approvals in the UI (required)
Your webview should render a small **Approval Queue** (or inline approval cards in the output stream) for any privileged/destructive action.

**Actions requiring approval**
- Run terminal commands (`run_command`)
- Write/patch files (`write_file` / applying @@EDIT blocks)
- Move/rename files (`move_file`)
- Delete files (`delete_file`)

**Approval card content (minimum)**
- Action type (e.g., `run_command`, `delete_file`)
- Target(s): file path(s) or command + cwd
- Reason (model-provided)
- Preview:
  - For edits: diff view link + summary
  - For move: `from → to`
  - For delete: file path + size (if known)
  - For commands: the full command line
- Buttons: **Approve** / **Deny** (and optionally **Approve & Don’t ask again for this session** for *non-destructive* actions only)

**Extension-host contract**
- When the agent wants to do an approved action, the extension host emits:
  - `approval/request` with `{ approvalId, action, payload, reason }`
- The webview responds with:
  - `approval/response` with `{ approvalId, approved: boolean }`
- The AgentRunner awaits a promise resolver stored in `Map<approvalId, ...>`.

**UX tips**
- Default focus: Deny / Cancel.
- Show approvals as a list so multiple requested actions can be handled one-by-one.
- Always show a short status line in the output: “Waiting for approval: delete_file …”

### Truncation
To stay within the 16K context budget:
- Truncate file reads (e.g., 50,000 chars per file) and label truncation clearly.

### Terminal execution (Windows 11)
- For **captured output**, prefer `child_process.exec()` / `spawn()` in the extension host (with caps on output).
- For **visibility**, optionally mirror the command into an integrated terminal via `terminal.sendText()`.

### Approval mechanism
- Maintain a `Map<approvalId, resolver>` in the runner.
- When a tool requests approval, emit an event to the webview to render an inline Approve/Deny card.
- Resolve the promise when user clicks.

---

## Build Tooling
Use **esbuild** with two bundles:

- Extension host bundle: `src/extension.ts` → `dist/extension.js` (Node/CJS, `external: ['vscode']`)
- Webview bundle: `webview-ui/main.ts` → `dist/webview.js` (browser)

Add scripts: `build`, `watch`, `typecheck`, `vscode:prepublish`.


---

## Recommended Feature Phases

### Phase 0 — Bootstrap (streaming-first)
**Deliverable:** a sideloaded extension that shows your UI and **streams** responses from the local endpoint.

- Create extension scaffold (TypeScript).
- Add a **webview view** (sidebar) contributed via a command (e.g., `agentic.openPanel`).
- Implement the UI (plain HTML/JS is fine to start):
  - Multiline `<textarea>` prompt
  - Attached files list
  - “Attach files” button
  - “New session” button
  - “Send” button
  - “Stop” button (cancel generation)
  - Output area that renders markdown
- Implement an OpenAI-compatible streaming client:
  - `POST /chat/completions` with `stream: true`
  - Parse SSE `data:` frames, append `delta.content` as it arrives
  - Handle `[DONE]`, errors, reconnect-safe cleanup
  - `AbortController` to cancel
- Hardcode the model settings initially (endpoint/model/context).

**Acceptance checks**
- You can type a prompt, click Send, and watch the markdown output appear progressively.
- Clicking Stop cancels promptly.

**Acceptance checks**
- You can type a prompt, click Send, and see the markdown response.

---

### Phase 1 — File Attach + Workspace Read (core value)
**Deliverable:** attach one+ files from workspace, send their contents to the model, and show response.

- Attach flow:
  - Use `vscode.window.showOpenDialog({ defaultUri: workspaceFolder, canSelectMany: true })`
  - Restrict selections to inside the workspace.
  - Read file contents using `vscode.workspace.fs.readFile`.
  - Store each attachment as:
    - `uri`, `relativePath`, `languageId` (optional), `content` (string), `sizeBytes`
- Apply safety/limits to avoid huge context:
  - Per-file cap (e.g., 200–400 KB)
  - Total attached content cap (e.g., 1–2 MB raw, or lower if needed)
  - If content is too large, include:
    - File path + note that it was truncated
    - First N lines + last N lines, or chunking (later)

**Acceptance checks**
- Attach 2–3 files, ask the model to explain/modify them, and see a coherent response.

---

### Phase 2 — Write Files (apply patches safely)
**Deliverable:** the model can propose edits that you can apply with a preview.

Start simple: require the model to output changes in a **structured edit format** you control.

#### Minimal edit format (recommended initially)
Use a fenced block that describes *replace operations* by file:

```text
@@EDIT path=src/foo.ts
REPLACE
FROM:
<exact old text>
TO:
<new text>
@@END
```

- The extension host parses these blocks.
- Before writing:
  - Validate the target path is in workspace.
  - Confirm the `FROM` text exists (exact match). If not, fail safely.
  - Show a diff (use VS Code diff API by writing to a temp document, or use `vscode.commands.executeCommand('vscode.diff', ...)`).
  - Require explicit user approval: **Apply** / **Cancel**.
- Apply via `vscode.workspace.fs.writeFile`.

**Acceptance checks**
- The model can suggest a small edit; you preview a diff; applying updates the file.

---

### Phase 3 — Sessions (multi-turn memory)
**Deliverable:** “New session” clears context; sessions persist locally.

- A session is:
  - `sessionId`, `title`, `createdAt`
  - message list: `{ role: 'user'|'assistant'|'system', content: string }`
  - attachments list (either per message or session-level)
- Persistence options:
  - `context.workspaceState` for workspace-scoped sessions
  - `context.globalState` for machine-wide sessions
  - Or JSON file in `.vscode/agentic-sessions.json` (easy to inspect)

UI:
- “New session” button creates a new session and clears the output.
- Optional: session dropdown/list later.

**Acceptance checks**
- You can close/reopen VS Code and still find the last session (if you choose persistence).

---

### Phase 4 — Terminal Commands and File Ops with Approvals (nice-to-have)
**Deliverable:** the model can request commands and file operations; user approves; results can be returned to the model.

Supported requested actions:
- `run_command`
- `move_file`
- `delete_file`

- Keep it safe:
  - Always show an approval card in the **webview UI** (and optionally also a VS Code modal for extra safety on deletes).
  - Deny by default; no background execution.
  - For deletes, consider requiring **typed confirmation** (e.g., user must type the filename) if you want belt-and-suspenders.

- Execution:
  - Commands: prefer `child_process.spawn/exec` for captured output; optionally mirror to integrated terminal.
  - Move: `vscode.workspace.fs.rename(from, to, { overwrite: false })` (or prompt if destination exists).
  - Delete: `vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true })` (prefer trash if available).

- Feed results back to model:
  - Provide a compact summary and capped output.

**Acceptance checks**
- Model requests a command/move/delete; you approve; the action runs; UI shows the result.

---

## The “Agentic” Loop (Simple, Controlled)
You don’t need a full autonomous agent at first. Use a **single-turn** or **light iterative** approach:

1. User prompt + selected file contents → model
2. Model responds with:
   - Markdown explanation
   - Optional structured edit blocks
   - Optional run_command JSON
3. Extension executes only what you approve.
4. (Optional) Send results back to model for a final summary.

Keep the loop deterministic and explicit.

---

## Short Simple Agentic Prompt (System)
Use a compact system prompt that supports tools and keeps approvals explicit.

```text
You are a coding assistant.
Respond in Markdown.
You can request tools to read/write/list/move/delete files and run shell commands.
Any write, move, delete, or command must be explicitly approved by the user before execution.
Use tools to understand the codebase before proposing changes.
Be concise.
```
```

### Suggested message packing
When calling `/chat/completions`, build messages like:
- `system`: the prompt above
- `user`: user request + attachments payload

Attachment payload format example:

```text
# Attached files
- path: src/a.ts
```ts
...content...
```

- path: README.md
```md
...content...
```
```

---

## Model Request Defaults
Start with settings that are stable for local models:
- `temperature`: 0.2–0.4
- `top_p`: 0.9
- `max_tokens`: 1500–3000 (tune)
- `stream`: **true (required)**
- `presence_penalty` / `frequency_penalty`: 0 (unless you find repetition issues)

**Streaming controls**
- Add a **Stop** button that aborts the request via `AbortController`.
- Throttle UI updates (e.g., flush deltas every 30–100ms) to avoid DOM churn.
- Keep a rolling buffer of the current assistant message and re-render markdown on a cadence (not per token).

---

## Security & Guardrails (especially because “uncensored” model)
Even if you trust yourself, guardrails prevent accidental damage:

- **Workspace boundary checks**: never read/write outside workspace.
- **Edit validation**: only apply edits when `FROM` matches exactly.
- **Diff + approval**: always show changes.
- **Command approval**: always prompt; deny by default.
- **Content caps**: truncate attachments and terminal output.
- **Logging**: keep a lightweight local log of actions taken (optional).

---

## Implementation Checklist

### Extension host
- [ ] Commands: `agentic.openPanel`, `agentic.newSession`, `agentic.attachFiles`
- [ ] Webview panel + message bridge
- [ ] LLM client (OpenAI-compatible)
- [ ] Workspace file read
- [ ] Edit parser + diff preview + write
- [ ] Session storage
- [ ] Terminal command approval + execution (optional)

### Webview UI
- [ ] Textarea prompt
- [ ] Attach files button + list
- [ ] New session button
- [ ] Send button
- [ ] Markdown renderer (e.g., `marked` + DOMPurify)
- [ ] Display status/errors

---

## Testing Strategy
- Start with a small demo repo.
- Unit test parsers (edit block parsing, command JSON extraction).
- Manual tests:
  - Attach a file → ask for explanation
  - Ask for small edit → preview diff → apply
  - Ask to run tests → approve command

---

## Phase 5 — Better Streaming UX (after MVP)
Once streaming is working, improve feel and robustness:

- Incremental markdown rendering strategy:
  - Append raw text deltas to a buffer
  - Re-render markdown on a timer (e.g., every 100ms) or on punctuation/newlines
  - Sanitize with DOMPurify
- Add token/throughput stats (if your server returns usage)
- Add resilient cancellation + cleanup:
  - Stop button aborts
  - Runner resets state on cancel
  - UI indicates “Cancelled” vs “Completed”
- Add backpressure handling:
  - If the webview is hidden, buffer deltas and flush when visible
- Add “copy raw” and “copy markdown” actions
- Add token usage display (if your endpoint returns it).
- Add quick-pick for sessions.
- Add file tree picker instead of open dialog.
- Add “context builder” (auto attach active editor / selection).

---

## Suggested Folder Layout
- `src/extension.ts` (activation, commands, webview wiring)
- `src/llm/client.ts` (OpenAI-compatible HTTP)
- `src/agent/orchestrator.ts` (build messages, parse actions)
- `src/actions/editParser.ts`
- `src/actions/commandRunner.ts`
- `webview/index.html` (or `webview/src/*` if using a bundler)

---

## Done Definition (MVP)
You’re “done” when you can:
1) open the panel, 2) attach files, 3) ask for changes, 4) preview+apply edits, and 5) optionally approve terminal commands—using your local endpoint with predictable behavior.

