# Plan: LLM-Initiated File Discovery (`request_files` Protocol)

## Context
The LLM currently only sees files that the user manually attaches or that are auto-detected from the prompt. To reduce context bloat, the LLM should be able to discover what files exist before deciding what to read. This plan adds a two-phase protocol: the LLM requests a file listing (paths only), then uses the existing `request_chunks` protocol to read what it actually needs.

## Approach: Two-Phase, Paths-First, Separate Counters

1. **Discovery**: LLM emits `{"request_files": [...]}` → extension returns `<file_list>` blocks (paths only, no content)
2. **Reading**: LLM emits `{"request_chunks": [...]}` → extension returns `<file_chunk>` blocks (existing protocol)

Each phase has its **own independent counter**:
- `fileRound` / `MAX_FILE_ROUNDS = 2` — for glob discovery (new)
- `chunkRound` / `MAX_CHUNK_ROUNDS = 2` — for reading content (existing, unchanged)

This allows up to 2 discovery turns + 2 read turns per message, keeping the loop bounded while giving the LLM room to discover files and then read them without burning the same budget.

File discovery uses `vscode.workspace.findFiles()` (not shell commands) — workspace-scoped, cross-platform, already used in `FileTools.ts`. VS Code uses its internal file watcher index so excluded folders are never traversed. A `maxResults: 200` cap prevents runaway results on broad globs.

## Changes Required

### 1. `src/tools/ChunkManager.ts` — Add parsing + formatting helpers

Add after the `ChunkRequest` interface and `parseChunkRequests` function:

```typescript
export interface FileRequest {
  glob: string;
  reason?: string;
}

export function parseFileRequests(text: string): FileRequest[] | null {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) { continue; }
    const arr = (parsed as Record<string, unknown>)['request_files'];
    if (!Array.isArray(arr)) { continue; }
    const requests: FileRequest[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) { continue; }
      const obj = item as Record<string, unknown>;
      if (typeof obj['glob'] !== 'string' || !obj['glob']) { continue; }
      const req: FileRequest = { glob: obj['glob'] as string };
      if (typeof obj['reason'] === 'string') { req.reason = obj['reason']; }
      requests.push(req);
    }
    if (requests.length > 0) { return requests; }
  }
  return null;
}

export function formatFileListBlock(glob: string, paths: string[]): string {
  const body = paths.length > 0 ? paths.join('\n') : '(no files matched)';
  return `<file_list glob="${glob}" count="${paths.length}">\n${body}\n</file_list>`;
}
```

Note: `extractJsonCandidates` is already imported from `editParser.ts` in `ChunkManager.ts`.

### 2. `src/chat/ChatPanel.ts` — Update import

```typescript
import {
  chunkFile, formatChunkBlock, buildChunkMeta, parseChunkRequests,
  parseFileRequests, formatFileListBlock,   // ADD
  FileChunkMeta, FileChunk, ChunkRequest,
} from '../tools/ChunkManager';
```

### 3. `src/chat/ChatPanel.ts` — Insert handler in `_handleSend()` loop

Insert **before** the existing `parseChunkRequests` block (after the assistant turn is pushed to history):

```typescript
// Check if the model is requesting a file listing
const fileRequests = parseFileRequests(fullResponse);
if (fileRequests && fileRound < MAX_FILE_ROUNDS) {
  fileRound++;
  this._log.appendLine(`[files] ${fileRequests.length} glob request(s), round ${fileRound}/${MAX_FILE_ROUNDS}`);
  this._postMessage({ type: 'status', text: `Searching ${fileRequests.length} glob pattern(s)…` });
  const exclude = FILE_EXCLUDE_GLOB; // shared constant, see below
  const parts: string[] = [];
  for (const req of fileRequests) {
    this._log.appendLine(`[files] glob="${req.glob}" reason="${req.reason ?? ''}"`);
    let uris: vscode.Uri[] = [];
    try { uris = await vscode.workspace.findFiles(req.glob, exclude, 200); }
    catch (err) { this._log.appendLine(`[files] findFiles error: ${err}`); }
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const paths = uris.map(u => {
      for (const root of wsRoots) {
        if (u.fsPath.startsWith(root + path.sep) || u.fsPath === root) {
          return u.fsPath.slice(root.length + 1).replace(/\\/g, '/');
        }
      }
      return u.fsPath.replace(/\\/g, '/');
    }).sort();
    parts.push(formatFileListBlock(req.glob, paths));
    this._log.appendLine(`[files] matched ${paths.length} file(s)`);
  }
  this._history.push({ role: 'user', content: parts.join('\n\n') });
  continue;
}
```

Also add `const MAX_FILE_ROUNDS = 2;` and `let fileRound = 0;` alongside the existing `MAX_CHUNK_ROUNDS` / `chunkRound` declarations at the top of `_handleSend()`.

Extract the exclude glob as a shared exported constant in `FileTools.ts` (it's already duplicated there between `FileTreeDataProvider.excludePatterns` and `findFilesForMention`):

```typescript
// In FileTools.ts — export this constant so ChatPanel can import it
export const FILE_EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**,**/*.log,**/.DS_Store}';
```

Import `FILE_EXCLUDE_GLOB` from `FileTools.ts` in `ChatPanel.ts` and use it in the `request_files` handler. This keeps exclusions consistent across all file search operations.

Check whether `path` is already imported in `ChatPanel.ts`; if not, add `import * as path from 'path';`.

### 4. `src/chat/ChatPanel.ts` — System prompt addition

Insert a new section after the "Requesting additional chunks" section and before "Editing files":

````
## Discovering files — request_files

To find out which files exist before deciding what to read, output a JSON object with a `request_files` array **instead of** `edits` or `request_chunks`:

```json
{
  "request_files": [
    { "glob": "src/**/*.ts", "reason": "Find all TypeScript source files" }
  ]
}
```

- `glob`: pattern relative to workspace root (e.g. `src/**/*.ts`, `README.md`). Be specific — avoid `**/*` or other broad patterns that match hundreds of files. Common folders like `node_modules`, `.git`, `dist`, and `build` are always excluded automatically.
- `reason`: brief explanation (ignored by client, useful for debugging)

The client returns a `<file_list>` block with workspace-relative paths:

```
<file_list glob="src/**/*.ts" count="3">
src/chat/ChatPanel.ts
src/tools/ChunkManager.ts
src/tools/FileTools.ts
</file_list>
```

After receiving the list, use `request_chunks` to read the files you need. `request_files` has its own 2-turn limit; `request_chunks` has a separate 2-turn limit. Do not combine `request_files` with `edits` or `request_chunks` in the same response.
````

### 5. Add `@vscode/ripgrep` dependency

Add to `package.json` dependencies:
```json
"@vscode/ripgrep": "^1.15.9"
```

`@types/node` is already a devDependency so `child_process` types are available.

The package exports a single `rgPath` string — the absolute path to the rg binary for the current platform. It downloads its own binary on install (does not rely on VS Code's bundled rg).

### 6. `src/tools/ChunkManager.ts` — Add ripgrep-based best-line finder

Add a function that runs rg against a file to find the line number of the best match for the prompt, with token-scoring fallback:

```typescript
import * as cp from 'child_process';
import { rgPath } from '@vscode/ripgrep';

/**
 * Extract meaningful search terms from a prompt: identifiers, camelCase/PascalCase words,
 * words longer than 4 chars. Used as rg search patterns.
 */
export function extractPromptTokens(prompt: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  const add = (w: string) => { if (w.length > 3 && !seen.has(w)) { seen.add(w); tokens.push(w); } };
  // camelCase/PascalCase sub-words
  for (const w of prompt.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)/g) ?? []) { add(w.toLowerCase()); }
  // whole words > 4 chars
  for (const w of prompt.split(/\W+/)) { if (w.length > 4) { add(w.toLowerCase()); } }
  return tokens;
}

/**
 * Use ripgrep to find the best matching line number in a file for the given tokens.
 * Returns the 1-based line number of the first/best match, or null if rg fails or no match.
 */
export async function findBestLineWithRg(
  absolutePath: string,
  tokens: string[]
): Promise<number | null> {
  if (tokens.length === 0) { return null; }
  // Build an alternation pattern: token1|token2|token3
  const pattern = tokens.slice(0, 10).join('|');
  return new Promise(resolve => {
    const args = [
      '--line-number',   // emit line numbers
      '--no-heading',    // one match per line of output
      '--case-sensitive',
      '--max-count', '1', // stop after first match
      '-e', pattern,
      absolutePath
    ];
    let stdout = '';
    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn(rgPath, args);
    } catch {
      resolve(null);
      return;
    }
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
      // rg output format: "<linenum>:<content>"
      const m = stdout.match(/^(\d+):/m);
      resolve(m ? parseInt(m[1], 10) : null);
    });
    proc.on('error', () => resolve(null));
    // Timeout safety: kill after 2s
    setTimeout(() => { proc.kill(); resolve(null); }, 2000);
  });
}

/**
 * Fallback: score already-loaded chunks by token frequency.
 * Returns the best chunk index (0-based), defaulting to 0.
 */
function scoreChunks(chunks: FileChunk[], tokens: string[]): number {
  let bestIdx = 0, bestScore = 0;
  for (let i = 0; i < chunks.length; i++) {
    const lower = chunks[i].content.toLowerCase();
    const score = tokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Select the single best chunk for initial delivery using rg if available,
 * falling back to token scoring over loaded chunks.
 * absolutePath: the OS absolute path to the file (for rg).
 */
export async function selectBestChunk(
  chunks: FileChunk[],
  absolutePath: string,
  tokens: string[]
): Promise<FileChunk> {
  if (chunks.length === 1) { return chunks[0]; }
  const nearLine = await findBestLineWithRg(absolutePath, tokens);
  if (nearLine !== null) {
    // Find the chunk whose range contains or is nearest to nearLine
    let best = chunks[0];
    let bestDist = Math.abs(nearLine - chunks[0].lineStart);
    for (const c of chunks) {
      if (nearLine >= c.lineStart && nearLine <= c.lineEnd) { return c; } // exact
      const dist = Math.min(Math.abs(nearLine - c.lineStart), Math.abs(nearLine - c.lineEnd));
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    return best;
  }
  // Fallback: token scoring over loaded chunks
  return chunks[scoreChunks(chunks, tokens)];
}
```

### 7. `src/chat/ChatPanel.ts` — Use ripgrep-based chunk selection for initial delivery + add UI status

Add `import * as path from 'path';` at the top (not currently imported).

Currently, when files are auto-detected and chunks are sent upfront, there is only a log entry — no UI status message. Add one after the chunk blocks are built:

```typescript
if (chunkBlocks.length > 0) {
  this._postMessage({ type: 'status', text: `Sending chunks for ${newFiles.length} file(s)…` });
}
```

Extract prompt tokens once before the `newFiles` loop, then replace `chunks.slice(0, 2)` at [ChatPanel.ts:405](src/chat/ChatPanel.ts#L405):

```typescript
// Once, before the newFiles loop:
const promptTokens = extractPromptTokens(prompt);

// Inside the newFiles loop, replace chunks.slice(0, 2) with:
const wsRoot = wsRoots[0] ?? '';
const absolutePath = path.join(wsRoot, f.relativePath);
this._postMessage({ type: 'status', text: `Searching ${f.relativePath}…` });
const best = await selectBestChunk(chunks, absolutePath, promptTokens);
chunkBlocks.push(formatChunkBlock(best));
this._log.appendLine(`[chunks] sending ${best.uri} lines ${best.lineStart}-${best.lineEnd} (rg-scored, total=${best.totalChunks})`);
```

Add `extractPromptTokens`, `selectBestChunk` to the `ChunkManager` import in `ChatPanel.ts`.

This applies only to **auto-detected files** (the `newFiles` loop). Manually attached files keep their existing 2-chunk delivery (the user explicitly chose those files, so more context is appropriate).

## UI Status Coverage

| Event | Status message |
|---|---|
| rg search per auto-detected file | `"Searching src/foo.ts…"` |
| After all upfront chunks built | `"Sending chunks for N file(s)…"` |
| LLM requests file listing | `"Searching N glob pattern(s)…"` |
| LLM requests more chunks | `"Fetching N requested chunk(s)…"` (existing) |
| Chunk limit reached | warning message (existing) |

## Files to Modify
- [package.json](package.json) — add `@vscode/ripgrep` dependency
- [src/tools/ChunkManager.ts](src/tools/ChunkManager.ts) — add `FileRequest`, `parseFileRequests()`, `formatFileListBlock()`, `extractPromptTokens()`, `findBestLineWithRg()`, `selectBestChunk()`
- [src/tools/FileTools.ts](src/tools/FileTools.ts) — export `FILE_EXCLUDE_GLOB` constant (consolidates the duplicated exclude pattern already in the file)
- [src/chat/ChatPanel.ts](src/chat/ChatPanel.ts) — add `path` import, update ChunkManager imports, insert `request_files` handler in loop, add system prompt section, replace initial chunk delivery with rg-scored selection

## Verification
1. `npm run build` — should produce clean output
2. In the chat panel, send a prompt that causes the LLM to emit `{"request_files": [{"glob": "src/**/*.ts"}]}`
3. Verify the extension logs show `[files] matched N file(s)`
4. Verify the LLM's next response uses `request_chunks` to read specific files
5. Verify the final response contains correct edits
