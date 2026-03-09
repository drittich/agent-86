# Agent 86 — Coding Guidelines

## File Length

Keep source files under **500 lines** where possible. If a file grows beyond that, look for a clean seam to split it — by feature, responsibility, or data type. Prefer many focused modules over a few large ones.

Exceptions are acceptable for files that are inherently monolithic (e.g. a single large CSS string constant), but these should be rare and noted.

## Project Structure

- `src/` — VS Code extension host (Node.js, CJS)
- `webview-ui/` — Chat panel UI (browser, ESM → bundled to IIFE by esbuild)
  - `main.ts` — entry point: bootstrap, event wiring, message handler
  - `template.ts` — HTML template string
  - `styles/` — CSS string constants (base, warning, approval)
  - `output.ts` — markdown rendering, segment buffer
  - `providers.ts` — provider state and dropdown rendering
  - `approvals.ts` — approval/warning/question cards
  - `utils.ts` — shared utilities (e.g. `escapeHtml`)

## Webview Notes

- All styles are inline (no external CSS file) — use `--vscode-*` CSS variables only
- No frontend framework — vanilla TypeScript + DOM
- Build: `npm run build` (esbuild); typecheck: `npm run typecheck`
