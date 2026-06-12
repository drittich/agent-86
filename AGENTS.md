# Agent 86 — Coding Guidelines

## File Length

Keep source files under **500 lines** where possible. If a file grows beyond that, look for a clean seam to split it — by feature, responsibility, or data type. Prefer many focused modules over a few large ones.

Exceptions are acceptable for files that are inherently monolithic (e.g. a large CSS string constant), but these should be rare and noted.

## Project Structure

- `src/` — VS Code extension host (Node.js, CJS)
  - `extension.ts` — activation entry point, command registration
  - `agent/AgentRunner.ts` — agentic loop: drives multi-step tool execution
  - `chat/ChatPanel.ts` — main orchestrator: prompt building, streaming loop, tool dispatch
  - `chat/ChatPanelEdits.ts` — legacy JSON anchor edit processing (fallback path only)
  - `chat/ChatPanelActions.ts` — legacy XML block processing (fallback path only)
  - `chat/ChatPanelChunks.ts` — legacy file chunk/search/listing logic (fallback path only)
  - `chat/ChatPanelSessions.ts` — session persistence and history management
  - `chat/DiffContentProvider.ts` — VS Code diff view content provider
  - `chat/messageProtocol.ts` — webview ↔ extension message types
  - `config/ConfigManager.ts` — provider/model configuration
  - `providers/AIProvider.ts` — Vercel AI SDK wrapper; `fullStream` (native tools) or `textStream` (fallback)
  - `providers/IProvider.ts` — `ChatMessage`, `ProviderEvent`, `StreamOptions` interfaces
  - `providers/ProviderFactory.ts` — provider instantiation
  - `tools/ToolRegistry.ts` — native tool definitions using `jsonSchema()` + `tool()` from `ai`
  - `tools/ToolExecutor.ts` — executes native tool calls with approval gates
  - `tools/FileTools.ts` — file read/write/replace/copy/move/delete tools
  - `tools/TerminalTool.ts` — `execute_bash` tool
  - `tools/MoveFileTool.ts` — move/rename tool
  - `tools/DeleteFileTool.ts` — delete tool
  - `tools/ChunkManager.ts` — file chunking for large-file context
  - `tools/TokenCounter.ts` — token estimation utilities
  - `tools/editParser.ts` — parses structured edit blocks
  - `tools/webSearch/` — web search pipeline (intent → query → fetch → rank → normalize)
  - `utils/PromptProcessor.ts` — system prompt assembly
  - `utils/GitIgnoreFilter.ts` — gitignore-aware file filtering

- `webview-ui/` — Chat panel UI (browser, ESM → bundled to IIFE by esbuild)
  - `main.ts` — entry point: bootstrap, event wiring, message handler
  - `template.ts` — HTML template string
  - `output.ts` — markdown rendering, segment buffer
  - `providers.ts` — provider state and dropdown rendering
  - `approvals.ts` — approval/warning/question cards
  - `utils.ts` — shared utilities (e.g. `escapeHtml`)
  - `styles/base.ts` — base CSS string constant
  - `styles/warning.ts` — warning card CSS
  - `styles/approval.ts` — approval card CSS

## Tool Calling

- Tool support is **auto-detected per model** (no manual setting): a one-time probe (`src/providers/ToolSupportProbe.ts`) sends a trivial `ping` tool and caches the verdict per `baseUrl::model` in globalState; runtime fallbacks demote a model that stops producing tool calls. Re-detect via the "Re-detect Tool Support for Active Model" command.
- **Native tools** (verdict: supported): uses `fullStream`, emits `tool-call` events, executes via `ToolExecutor`, feeds results back as `tool` messages in history
- **Legacy fallback** (verdict: unsupported): uses `textStream`, parses XML/JSON in-text blocks via `ChatPanelActions`/`ChatPanelEdits`
- Tool definitions use `inputSchema` (not `parameters`) — Vercel AI SDK v6
- `streamText` `fullStream` events: `text-delta`, `tool-call` (`.input` not `.args`), `tool-result`, `finish-step`

## Webview Notes

- All styles are CSS string constants in `webview-ui/styles/` — injected at runtime; use `--vscode-*` CSS variables only, never hardcode colors
- No frontend framework — vanilla TypeScript + DOM
- Build: `npm run build` (esbuild); typecheck: `npm run typecheck`
