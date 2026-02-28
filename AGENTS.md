# Agent 86 — Extension Guide (for AI coding agents)

## What this is
VS Code extension with a chat panel backed by a **local OpenAI-compatible LLM**. The model emits **XML action blocks**; the extension parses them **after streaming ends** and **queues actions for user approval** (required for destructive actions).

> **Keep context small:** this app runs with **tight context window/memory constraints**. Any changes should preserve concise prompts, minimal message history, and lean file attachments.

## Key paths
- `src/extension.ts` — activation + commands
- `src/chat/ChatPanel.ts` — orchestrator: webview, prompt/history, streaming, parse actions, approval queue, execute, feed results back
- `src/providers/OpenAIProvider.ts` — OpenAI-compatible `/chat/completions` streaming SSE
- `src/tools/` — action parsing/execution: `editParser.ts`, `TerminalTool.ts`, `MoveFileTool.ts`, `DeleteFileTool.ts`, `FileTools.ts`
- `webview-ui/main.ts` — UI (vanilla TS): renders deltas + approval cards
- `dist/` — build output (do not edit)
- `esbuild.js` — bundles: extension (CJS) + webview (IIFE)

## Build
```bash
npm install
npm run build
npm run watch
npm run typecheck
npm run vscode:prepublish
```
Notes: `vscode` is **external** and must **not** be imported in `webview-ui/`. No Node built-ins in `webview-ui/`.

## XML action blocks (model output)
### Edit
```xml
<EDIT path="relative/path.ts">
<FROM>exact text (empty = replace whole file)</FROM>
<TO>replacement (empty = delete FROM)</TO>
</EDIT>
```
Rules: path must be **workspace-relative**, no `..`, no absolute roots. `<FROM>` must match **exactly once** unless empty.

### Run
```xml
<RUN>npm test</RUN>
```

### Move
```xml
<MOVE>
FROM: a.ts
TO: b.ts
</MOVE>
```

### Delete
```xml
<DELETE>
PATH: src/unused.ts
</DELETE>
```

## Adding a new tool/action type
1) parser/executor in `src/tools/`  
2) dispatch + approval queue in `ChatPanel.ts`  
3) approval UI in `webview-ui/main.ts`  
4) update system prompt in `ChatPanel.ts`  
5) update `messageProtocol.ts` types

## Operational limits (keep outputs compact)
- `TerminalTool`: 30s timeout, ~32KB output cap
- `FileTools`: ~300KB per file, ~1.5MB total attachments
- Provider defaults: `max_tokens` ~2048 (see `OpenAIProvider.ts`)
