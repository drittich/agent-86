# Agent 86 — VSCode Extension Developer Guide

This document describes the architecture and conventions for the Agent 86 VSCode extension, intended for AI coding agents working on this codebase.

## Project Overview

Agent 86 is a VS Code extension that provides a chat panel connected to a local OpenAI-compatible LLM. The model can edit files, run shell commands, move files, and delete files using structured XML action blocks embedded in its responses. All destructive actions require user approval before execution.

## Repository Structure

```
vscode-agent-extension/
├── src/                          # Extension host code (Node.js, CommonJS)
│   ├── extension.ts              # Entry point — command registration, activation
│   ├── chat/
│   │   ├── ChatPanel.ts          # Core orchestrator: webview, LLM, action dispatch
│   │   └── messageProtocol.ts    # TypeScript types for webview ↔ extension messages
│   ├── config/
│   │   └── ConfigManager.ts      # Session persistence (VS Code workspace state)
│   ├── providers/
│   │   ├── IProvider.ts          # LLM provider interface
│   │   └── OpenAIProvider.ts     # OpenAI-compatible streaming API
│   └── tools/
│       ├── editParser.ts         # <EDIT> block parsing, validation, application
│       ├── TerminalTool.ts       # <RUN> block execution (shell commands)
│       ├── MoveFileTool.ts       # <MOVE> block (file rename/move)
│       ├── DeleteFileTool.ts     # <DELETE> block (move to OS trash)
│       └── FileTools.ts          # File picker, auto-detection, content reading
├── webview-ui/
│   ├── main.ts                   # Browser-side chat UI (vanilla TypeScript, IIFE)
│   └── tsconfig.json             # Separate tsconfig for browser bundle
├── dist/                         # Build output (do not edit directly)
│   ├── extension.js
│   └── webview.js
├── esbuild.js                    # Build config (two-bundle: extension + webview)
├── package.json                  # Extension manifest, commands, config schema
└── tsconfig.json                 # Extension host TypeScript config
```

## Build

```bash
npm install          # Install dependencies
npm run build        # Development build (sourcemaps, not minified)
npm run watch        # Watch mode (rebuilds on save)
npm run typecheck    # Type-check without building
npm run vscode:prepublish  # Production build (minified)
```

Build uses esbuild with two separate bundles:
- **Extension host**: `src/extension.ts` → `dist/extension.js` (CommonJS, Node.js)
- **Webview UI**: `webview-ui/main.ts` → `dist/webview.js` (IIFE, browser)

A clean build produces no stdout. Errors and warnings are printed to stdout/stderr.

The `vscode` module is external (provided by VS Code at runtime) and must never be imported in `webview-ui/`.

## Architecture

### Message Flow

```
User (webview UI)
  │  postMessage({ type: 'send', text: '...' })
  ▼
ChatPanel.ts  (extension host)
  │  Builds message history + system prompt
  │  Injects attached file contents as <file> XML
  ▼
OpenAIProvider.ts
  │  Streams SSE from local LLM (OpenAI-compatible endpoint)
  ▼
ChatPanel.ts  (receives streamed deltas)
  │  Forwards delta chunks to webview for live rendering
  │  On stream end: parses action blocks from full response
  ▼
Tools (editParser, TerminalTool, MoveFileTool, DeleteFileTool)
  │  Each action block queued for user approval
  ▼
Webview approval cards
  │  User approves or denies each action
  ▼
ChatPanel.ts  (executes approved actions)
  │  Results formatted as XML result tags
  ▼
New user message injected with results → next LLM turn
```

### Action Block XML Syntax

The system prompt instructs the model to emit structured XML blocks. The extension parses these after the stream completes.

#### Edit a File
```xml
<EDIT path="src/utils/math.ts">
<FROM>
exact text to find (empty = full-file replacement)
</FROM>
<TO>
replacement text (empty = delete the FROM text)
</TO>
</EDIT>
```

- Empty `<FROM></FROM>` triggers a full-file replacement (use when file content is unknown).
- Empty `<TO></TO>` deletes the matched text.
- Multiple `<EDIT>` blocks can appear in one response.

#### Run a Shell Command
```xml
<RUN>
npm test
</RUN>
```
Result fed back: `<RUN_RESULT command="npm test" status="exit_code=0">...stdout/stderr...</RUN_RESULT>`

#### Move/Rename a File
```xml
<MOVE>
FROM: src/old-name.ts
TO: src/new-name.ts
</MOVE>
```
Result: `<MOVE_RESULT from="..." to="..." status="success"/>`

#### Delete a File
```xml
<DELETE>
PATH: src/unused.ts
</DELETE>
```
Result: `<DELETE_RESULT path="..." status="success (moved to trash)"/>`

### Path Validation Rules

All file paths in action blocks are validated before execution:
- Must be relative (no leading `/` or drive letters)
- Must not contain `..` path traversal
- Must resolve within the VS Code workspace root(s)

Violations are rejected and reported to the user.

## Key Modules

### `src/chat/ChatPanel.ts`
The central orchestrator. Implements `vscode.WebviewViewProvider`.

Key responsibilities:
- Manages webview lifecycle and message routing
- Builds LLM request (system prompt + message history + file attachments)
- Streams responses, forwards deltas to webview
- Parses action blocks from completed response
- Coordinates approval workflow (diff preview → user approval → execute → feed result back)
- Handles session save/restore via ConfigManager

When modifying: be careful with the approval queue — actions must execute in order, and results must be concatenated into a single follow-up user message.

### `src/tools/editParser.ts`
Parses and applies `<EDIT>` blocks.

Key functions:
- `parseEditBlocks(text)` — extracts all EDIT blocks, strips internal model tokens and markdown fences
- `resolveEditPath(relPath, roots)` — validates path is safe and workspace-relative
- `validateFromText(block, content)` — checks FROM text appears exactly once (or is empty)
- `applyEditBlock(block, content)` — performs the string replacement

Token stripping: some local LLMs leak internal tokens (e.g., `<|channel|>`) into output which corrupt XML parsing. The parser strips these before attempting to match tags.

### `src/tools/TerminalTool.ts`
Parses `<RUN>` blocks and spawns shell processes.
- Shell: `cmd.exe` on Windows, `/bin/sh` on Unix
- Timeout: 30 seconds
- Output cap: 32 KB (truncated with notice if exceeded)

### `src/tools/FileTools.ts`
- `pickAndReadFiles()` — VS Code file picker with checkboxes, reads selected files
- `autoDetectAndAttachFiles(prompt, roots)` — scans user message for file path mentions
- `readActiveEditor()` — reads the currently focused editor file
- File size limits: 300 KB per file, 1.5 MB total across all attached files

### `src/config/ConfigManager.ts`
Persists sessions to VS Code workspace state. Each session stores the full message history and attached file list. Titles are auto-derived from the first user message.

### `webview-ui/main.ts`
Vanilla TypeScript (no framework). Bundled as a browser IIFE.
- Builds the entire UI DOM dynamically (no HTML template)
- Renders streaming markdown via `marked` + `DOMPurify`
- Handles approval cards with "Approve & Don't Ask Again" for non-destructive actions
- Buffers delta messages when the webview panel is hidden (backpressure)
- Auto-focuses the Deny button on approval cards (safer default)

### `src/providers/OpenAIProvider.ts`
Calls any OpenAI-compatible `/chat/completions` endpoint with streaming SSE.
- Temperature: 0.3, top_p: 0.9, max_tokens: 2048
- Emits `delta` events per token chunk, `done` on `[DONE]`
- Handles `AbortSignal` for user-initiated cancellation
- Translates connection errors (ECONNREFUSED, etc.) into friendly messages

## VS Code Extension Commands

| Command ID | Title | Description |
|---|---|---|
| `agentic.openPanel` | Open Chat Panel | Show the chat sidebar |
| `agentic.newSession` | New Session | Clear history, start fresh |
| `agentic.attachFiles` | Attach Files | Open file picker |
| `agentic.attachActiveEditor` | Attach Active Editor | Attach current open file |
| `agentic.selectSession` | Select Session | Restore a previous session |

## VS Code Extension Settings

| Setting | Default | Description |
|---|---|---|
| `agentCoder.baseUrl` | `http://127.0.0.1:8083/v1` | LLM server base URL |
| `agentCoder.model` | *(local model name)* | Model identifier |
| `agentCoder.maxContextTokens` | `16384` | Token limit for context window |
| `agentCoder.provider` | `openai-compatible` | Provider type |

## Message Protocol (`messageProtocol.ts`)

All communication between the extension host and webview uses typed `postMessage` calls.

**Extension → Webview:**
- `delta` — Streamed token chunk
- `done` — Generation complete (with optional token usage stats)
- `error` — Error string to display
- `status` — Status bar text update
- `attachments` — Updated file attachment list
- `approval/request` — Show approval card for a pending action
- `editorState` — Whether an active editor exists (enables Attach Active Editor button)

**Webview → Extension:**
- `send` — User submitted a prompt
- `stop` — User cancelled generation
- `newSession` — Clear conversation
- `attachFiles` — Trigger file picker
- `attachActiveEditor` — Attach current file
- `selectSession` — Restore session
- `approval/response` — User approved or denied an action

## Development Notes

- The `vscode` module must never appear in `webview-ui/` imports — it is not available in the browser context.
- Do not import Node.js built-ins (`fs`, `path`, etc.) in `webview-ui/`.
- When adding a new action block type, you need to: (1) add the parser in `src/tools/`, (2) add the approval/dispatch logic in `ChatPanel.ts`, (3) add the approval card rendering in `webview-ui/main.ts`, (4) update the system prompt in `ChatPanel.ts`, (5) update `messageProtocol.ts` with any new message types.
- Edit errors (FROM text not found in file) surface as blockquote messages in the chat output, not just ephemeral status bar toasts.
- Run `npm run typecheck` before committing to catch type errors without a full build.
