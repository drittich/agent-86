import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';
import { extractJsonCandidates } from './editParser';

// Active rg binary path. initRgPath() sets this at runtime.
let _rgPath: string | null = null;

/**
 * Call once on extension activation with context.extensionPath.
 * Resolves rg binary in order:
 * 1. Bundled in <extensionPath>/bin/rg[.exe] (for packaged VSIX)
 * 2. Extension's node_modules/@vscode/ripgrep/bin/rg[.exe]
 * Returns a description of the resolved path for logging.
 */
export function initRgPath(extensionPath: string): string {
  const exeName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  
  // 1. Check for bundled binary (packaged VSIX)
  const bundled = nodePath.join(extensionPath, 'bin', exeName);
  if (fs.existsSync(bundled)) {
    _rgPath = bundled;
    return `bundled: ${_rgPath}`;
  }
  
  // 2. Check extension's own node_modules
  const nodeModulesRg = nodePath.join(
    extensionPath, 'node_modules', '@vscode', 'ripgrep', 'bin', exeName
  );
  if (fs.existsSync(nodeModulesRg)) {
    _rgPath = nodeModulesRg;
    return `node_modules: ${_rgPath}`;
  }
  
  // 3. Fallback: hope rg is on PATH
  _rgPath = 'rg';
  return 'fallback: rg (on PATH)';
}

/** Default chunk size in lines (small-context fallback). */
export const CHUNK_LINES = 120;
/** Overlap between adjacent chunks in lines. */
export const CHUNK_OVERLAP = 15;

/**
 * Chunk size scaled to the model's context window. Small local models (≤48k)
 * keep the conservative 120-line page; mid-context models get larger pages;
 * very-large-context models (e.g. DeepSeek V4, 1M) get pages big enough that
 * most files arrive whole in a single chunk — avoiding wasteful drip-feeding.
 */
export function chunkLinesForContext(contextTokens: number): number {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) { return CHUNK_LINES; }
  if (contextTokens <= 48_000) { return CHUNK_LINES; }
  if (contextTokens <= 256_000) { return 400; }
  return 1200;
}

/** A single chunk of a file. */
export interface FileChunk {
  /** Globally unique identifier: "<relativePath>:chunk:<index>" */
  chunkId: string;
  /** Workspace-relative path with forward slashes. */
  uri: string;
  /** 1-based start line (inclusive). */
  lineStart: number;
  /** 1-based end line (inclusive). */
  lineEnd: number;
  /** Total number of chunks for this file. */
  totalChunks: number;
  /** VS Code document version at the time of chunking. */
  docVersion: number;
  /** MD5 hex of the chunk content (for staleness detection). */
  hash: string;
  /** The raw text content of this chunk. */
  content: string;
}

/**
 * Metadata stored per-file. Enough to reconstruct or validate any chunk
 * without re-reading the file.
 */
export interface FileChunkMeta {
  uri: string;
  totalChunks: number;
  docVersion: number;
  /** MD5 hex per chunk, in order. */
  chunkHashes: string[];
  /** Line count of the file at last chunking. */
  lineCount: number;
}

/** A request from the model for additional chunks of a file. */
export interface ChunkRequest {
  uri: string;
  reason?: string;
  preferred?: {
    near_line?: number;
    line_range?: {
      start: number;
      end: number;
    };
    max_chunks?: number;
  };
}

/** Compute an MD5 hex digest of a string. */
function md5(text: string): string {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * Slice `fileContent` into overlapping 120-line chunks.
 *
 * - Lines are 1-indexed in returned metadata.
 * - Each chunk overlaps with the next by CHUNK_OVERLAP lines.
 * - A file shorter than CHUNK_LINES produces exactly one chunk.
 */
export function chunkFile(
  uri: string,
  fileContent: string,
  docVersion: number,
  chunkLines: number = CHUNK_LINES
): FileChunk[] {
  const lines = fileContent.split('\n');
  const totalLines = lines.length;
  const overlap = Math.min(CHUNK_OVERLAP, Math.max(0, chunkLines - 1));

  // Build chunk start indices (0-based)
  const starts: number[] = [];
  let pos = 0;
  while (pos < totalLines) {
    starts.push(pos);
    if (pos + chunkLines >= totalLines) {
      break;
    }
    pos += chunkLines - overlap;
  }

  const totalChunks = starts.length;

  return starts.map((start, index) => {
    const end = Math.min(start + chunkLines - 1, totalLines - 1); // 0-based inclusive
    const content = lines.slice(start, end + 1).join('\n');
    return {
      chunkId: `${uri}:chunk:${index}`,
      uri,
      lineStart: start + 1,
      lineEnd: end + 1,
      totalChunks,
      docVersion,
      hash: md5(content),
      content,
    };
  });
}

/** Build the `<file_chunk>` XML block string to inject into a ChatMessage. */
export function formatChunkBlock(chunk: FileChunk): string {
  return (
    `<file_chunk path="${chunk.uri}" chunk_id="${chunk.chunkId}" ` +
    `lines="${chunk.lineStart}-${chunk.lineEnd}" ` +
    `total_chunks="${chunk.totalChunks}" ` +
    `doc_version="${chunk.docVersion}" ` +
    `hash="${chunk.hash}">\n` +
    chunk.content +
    `\n</file_chunk>`
  );
}

/** Extract FileChunkMeta from a fully-chunked file. */
export function buildChunkMeta(chunks: FileChunk[]): FileChunkMeta {
  const first = chunks[0];
  return {
    uri: first.uri,
    totalChunks: first.totalChunks,
    docVersion: first.docVersion,
    chunkHashes: chunks.map(c => c.hash),
    lineCount: chunks[chunks.length - 1].lineEnd,
  };
}

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

/** A request from the model to search a file for a pattern. */
export interface SearchRequest {
  uri: string;
  pattern: string;
  /** Defaults to true; set false to run case-insensitive search. */
  caseSensitive?: boolean;
  reason?: string;
}

/**
 * Parse a `search_file` JSON object from an assistant response.
 * Returns null if no valid `search_file` key is found.
 */
export function parseSearchRequests(text: string): SearchRequest[] | null {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) { continue; }
    const arr = (parsed as Record<string, unknown>)['search_file'];
    if (!Array.isArray(arr)) { continue; }
    const requests: SearchRequest[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) { continue; }
      const obj = item as Record<string, unknown>;
      if (typeof obj['uri'] !== 'string' || !obj['uri']) { continue; }
      if (typeof obj['pattern'] !== 'string' || !obj['pattern']) { continue; }
      const req: SearchRequest = { uri: obj['uri'] as string, pattern: obj['pattern'] as string };
      if (typeof obj['case_sensitive'] === 'boolean') {
        req.caseSensitive = obj['case_sensitive'] as boolean;
      } else if (typeof obj['caseSensitive'] === 'boolean') {
        req.caseSensitive = obj['caseSensitive'] as boolean;
      }
      if (typeof obj['reason'] === 'string') { req.reason = obj['reason']; }
      requests.push(req);
    }
    if (requests.length > 0) { return requests; }
  }
  return null;
}

/** Format a `<search_result>` block to feed back to the model. */
export function formatSearchResultBlock(
  uri: string,
  pattern: string,
  matches: string[],
  matchCount: number,
  error?: string,
  caseSensitive = true
): string {
  const mode = caseSensitive ? 'true' : 'false';

  // Keep search results small to avoid blowing request size limits on the next round.
  const MAX_LINES = 220;
  const MAX_CHARS = 16_000;

  // When an error is present, keep any partial output (if available) so the model
  // can still make progress (e.g., output cap exceeded on directory searches).
  const rendered: string[] =
    matches.length > 0
      ? matches
      : (error ? [`(search error: ${error})`] : ['(no matches)']);

  const clippedLines = rendered.slice(0, MAX_LINES);
  let body = clippedLines.join('\n');
  let clipped = rendered.length > MAX_LINES;

  if (body.length > MAX_CHARS) {
    body = body.slice(0, MAX_CHARS);
    clipped = true;
  }

  if (clipped) {
    body += `\n\n(... truncated; showing ${Math.min(rendered.length, MAX_LINES)} line(s))`;
  }

  return (
    `<search_result uri="${uri}" pattern="${pattern}" case_sensitive="${mode}" count="${matchCount}"` +
    (error ? ` error="${error}"` : '') +
    `>\n${body}\n</search_result>`
  );
}

/**
 * Search a file or directory for a ripgrep pattern.
 *
 * Notes:
 * - For directory searches, use `rg --files-with-matches` (file list only) to keep stdout small;
 *   the model can then drill into specific files with targeted `search_file` calls.
 * - For file searches, include line numbers and provide a few context lines by re-reading the file.
 * - When `globFilter` is provided, passes it via `--glob` so rg filters files within the directory.
 */
export async function searchFileWithRg(
  absolutePath: string,
  pattern: string,
  caseSensitive = true,
  globFilter?: string
): Promise<{ lines: string[]; matchCount: number; error?: string }> {
  const MAX_MATCHES_PER_FILE = 50;
  const MAX_TOTAL_MATCH_LINES = 140; // across all files when searching a directory
  const CONTEXT_LINES = 2;
  const MAX_RESULT_LINE_CHARS = 400;
  const TRUNCATED_SUFFIX = ' [truncated]';
  const MAX_STDOUT_BYTES = 96 * 1024;
  const TIMEOUT_MS = 8000;

  const truncateSearchLine = (line: string): string => {
    if (line.length <= MAX_RESULT_LINE_CHARS) {
      return line;
    }
    const keep = Math.max(0, MAX_RESULT_LINE_CHARS - TRUNCATED_SUFFIX.length);
    return line.slice(0, keep) + TRUNCATED_SUFFIX;
  };

  const isDirectorySearch = (() => {
    try {
      return fs.statSync(absolutePath).isDirectory();
    } catch {
      return false;
    }
  })();

  const renderMatchesWithContext = (rawLines: string[]): string[] => {
    const matchLineNumbers = rawLines
      .map(l => /^(\d+):/.exec(l)?.[1])
      .filter((v): v is string => typeof v === 'string')
      .map(v => Number(v))
      .filter(n => Number.isInteger(n) && n > 0);

    if (matchLineNumbers.length === 0) {
      // Fall back to raw ripgrep output when line number parsing fails.
      return rawLines.map(truncateSearchLine);
    }

    try {
      const fileLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
      const result: string[] = [];
      for (let idx = 0; idx < matchLineNumbers.length; idx++) {
        const lineNo = matchLineNumbers[idx];
        const start = Math.max(1, lineNo - CONTEXT_LINES);
        const end = Math.min(fileLines.length, lineNo + CONTEXT_LINES);
        result.push(`@${lineNo}`);
        for (let i = start; i <= end; i++) {
          const marker = i === lineNo ? '>' : ' ';
          result.push(truncateSearchLine(`${marker} ${i}: ${fileLines[i - 1] ?? ''}`));
        }
        if (idx < matchLineNumbers.length - 1) {
          result.push('');
        }
      }
      return result;
    } catch {
      // Fall back to raw rg lines if the file cannot be read.
      return rawLines.map(truncateSearchLine);
    }
  };

  return new Promise(resolve => {
    if (!_rgPath) {
      resolve({ lines: [], matchCount: 0, error: 'rg binary not initialized' });
      return;
    }

    const rgPath = _rgPath; // Capture for closure

    const args = isDirectorySearch
      ? [
          '--files-with-matches',
          caseSensitive ? '--case-sensitive' : '--ignore-case',
          ...(globFilter ? ['--glob', globFilter] : []),
          '-e', pattern,
          '.',
        ]
      : [
          '--line-number',
          '--no-heading',
          caseSensitive ? '--case-sensitive' : '--ignore-case',
          '--max-count', String(MAX_MATCHES_PER_FILE),
          ...(globFilter ? ['--glob', globFilter] : []),
          '-e', pattern,
          absolutePath,
        ];

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let killedForCap = false;
    let proc: cp.ChildProcess;

    try {
      proc = isDirectorySearch
        ? cp.spawn(rgPath, args, { cwd: absolutePath })
        : cp.spawn(rgPath, args);
    } catch (e) {
      resolve({ lines: [], matchCount: 0, error: `spawn failed: ${e}` });
      return;
    }

    proc.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (!killedForCap && stdoutBytes > MAX_STDOUT_BYTES) {
        killedForCap = true;
        try { proc.kill(); } catch { /* ignore */ }
        return;
      }
      stdout += d.toString();
    });

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const capError = killedForCap ? `output cap exceeded (${Math.round(MAX_STDOUT_BYTES / 1024)}KB)` : undefined;
      const rgError = (code !== null && code > 1 && stderr.trim()) ? stderr.trim() : undefined;
      const error = rgError ?? capError;

      if (isDirectorySearch) {
        const raw = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        const limited = raw.slice(0, MAX_TOTAL_MATCH_LINES);
        const lines = limited
          .map(p => p.replace(/\\/g, '/'))
          .map(p => p.replace(/^\.\/?/, ''))
          .map(truncateSearchLine);
        resolve({ lines, matchCount: raw.length, error });
        return;
      }

      const allRawLines = stdout.split('\n').filter(l => l.trim() !== '');
      const limitedRawLines = allRawLines.slice(0, MAX_TOTAL_MATCH_LINES);
      const lines = renderMatchesWithContext(limitedRawLines);
      resolve({ lines, matchCount: allRawLines.length, error });
    });

    proc.on('error', (e) => resolve({ lines: [], matchCount: 0, error: `process error: ${e}` }));

    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve({ lines: [], matchCount: 0, error: 'timeout' });
    }, TIMEOUT_MS);
  });
}

/**
 * Parse a `request_chunks` JSON object from an assistant response.
 * Returns null if no valid `request_chunks` key is found.
 */
export function parseChunkRequests(text: string): ChunkRequest[] | null {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)['request_chunks'])
    ) {
      continue;
    }

    const arr = (parsed as { request_chunks: unknown[] }).request_chunks;
    const requests: ChunkRequest[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj['uri'] !== 'string' || !obj['uri']) {
        continue;
      }
      const req: ChunkRequest = { uri: obj['uri'] as string };
      if (typeof obj['reason'] === 'string') {
        req.reason = obj['reason'];
      }
      if (typeof obj['preferred'] === 'object' && obj['preferred'] !== null) {
        const pref = obj['preferred'] as Record<string, unknown>;
        req.preferred = {};
        if (typeof pref['near_line'] === 'number') {
          req.preferred.near_line = pref['near_line'] as number;
        }
        if (typeof pref['line_range'] === 'object' && pref['line_range'] !== null) {
          const range = pref['line_range'] as Record<string, unknown>;
          if (typeof range['start'] === 'number' && typeof range['end'] === 'number') {
            req.preferred.line_range = {
              start: range['start'],
              end: range['end'],
            };
          }
        }
        if (typeof pref['max_chunks'] === 'number') {
          req.preferred.max_chunks = pref['max_chunks'] as number;
        }
      }
      requests.push(req);
    }
    if (requests.length > 0) {
      return requests;
    }
  }
  return null;
}

/**
 * Build non-overlapping exact-range chunks from an already chunked file.
 *
 * - Input range is 1-based and inclusive.
 * - Range is clamped to the file line count.
 * - Output chunks are split into CHUNK_LINES pages (no overlap), capped by maxChunks.
 */
export function selectExactLineRangeChunks(
  chunks: FileChunk[],
  lineRange: { start: number; end: number },
  maxChunks = 2,
  chunkLines: number = CHUNK_LINES
): FileChunk[] {
  if (chunks.length === 0) {
    return [];
  }

  const fileLineCount = chunks[chunks.length - 1].lineEnd;
  if (fileLineCount <= 0) {
    return [];
  }

  const normalizeLine = (line: number): number => {
    if (!Number.isFinite(line)) { return 1; }
    return Math.min(fileLineCount, Math.max(1, Math.floor(line)));
  };

  let start = normalizeLine(lineRange.start);
  let end = normalizeLine(lineRange.end);
  if (start > end) {
    [start, end] = [end, start];
  }

  const chunkCap = Math.max(1, Math.floor(maxChunks || 1));
  const maxLines = chunkCap * CHUNK_LINES;
  const effectiveEnd = Math.min(end, start + maxLines - 1);

  const linesByNumber = new Map<number, string>();
  for (const chunk of chunks) {
    const chunkLines = chunk.content.split('\n');
    for (let i = 0; i < chunkLines.length; i++) {
      const lineNo = chunk.lineStart + i;
      if (!linesByNumber.has(lineNo)) {
        linesByNumber.set(lineNo, chunkLines[i] ?? '');
      }
    }
  }

  const allLines: string[] = [];
  for (let lineNo = 1; lineNo <= fileLineCount; lineNo++) {
    allLines.push(linesByNumber.get(lineNo) ?? '');
  }

  const uri = chunks[0].uri;
  const docVersion = chunks[0].docVersion;
  const result: FileChunk[] = [];
  let partIndex = 0;
  for (let pos = start; pos <= effectiveEnd; pos += CHUNK_LINES) {
    const sliceEnd = Math.min(effectiveEnd, pos + CHUNK_LINES - 1);
    const content = allLines.slice(pos - 1, sliceEnd).join('\n');
    result.push({
      chunkId: `${uri}:range:${start}-${effectiveEnd}:part:${partIndex}`,
      uri,
      lineStart: pos,
      lineEnd: sliceEnd,
      totalChunks: Math.ceil((effectiveEnd - start + 1) / CHUNK_LINES),
      docVersion,
      hash: md5(content),
      content,
    });
    partIndex++;
  }

  return result;
}

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
  if (!_rgPath) { return null; }
  const rgPath = _rgPath; // Capture for closure
  const pattern = tokens.slice(0, 10).join('|');
  return new Promise(resolve => {
    const args = [
      '--line-number',
      '--no-heading',
      '--case-sensitive',
      '--max-count', '1',
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
      const m = stdout.match(/^(\d+):/m);
      resolve(m ? parseInt(m[1], 10) : null);
    });
    proc.on('error', () => resolve(null));
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
 */
export async function selectBestChunk(
  chunks: FileChunk[],
  absolutePath: string,
  tokens: string[]
): Promise<FileChunk> {
  if (chunks.length === 1) { return chunks[0]; }
  const nearLine = await findBestLineWithRg(absolutePath, tokens);
  if (nearLine !== null) {
    let best = chunks[0];
    let bestDist = Math.abs(nearLine - chunks[0].lineStart);
    for (const c of chunks) {
      if (nearLine >= c.lineStart && nearLine <= c.lineEnd) { return c; }
      const dist = Math.min(Math.abs(nearLine - c.lineStart), Math.abs(nearLine - c.lineEnd));
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    return best;
  }
  return chunks[scoreChunks(chunks, tokens)];
}
