import * as crypto from 'crypto';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';
import { extractJsonCandidates } from './editParser';

// Injected at build time by esbuild define — absolute path to node_modules rg binary.
declare const __RG_DEV_PATH__: string;

// Active rg binary path. initRgPath() overrides this when a packaged binary exists.
let _rgPath: string = __RG_DEV_PATH__;

/**
 * Call once on extension activation with context.extensionPath.
 * Switches to the binary bundled in the packaged VSIX when available.
 * Returns a description of the resolved path for logging.
 */
export function initRgPath(extensionPath: string): string {
  const bundled = nodePath.join(extensionPath, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  if (fs.existsSync(bundled)) {
    _rgPath = bundled;
    return `bundled: ${_rgPath}`;
  }
  return `dev: ${_rgPath}`;
}

/** Chunk size in lines. */
export const CHUNK_LINES = 120;
/** Overlap between adjacent chunks in lines. */
export const CHUNK_OVERLAP = 15;

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
  docVersion: number
): FileChunk[] {
  const lines = fileContent.split('\n');
  const totalLines = lines.length;

  // Build chunk start indices (0-based)
  const starts: number[] = [];
  let pos = 0;
  while (pos < totalLines) {
    starts.push(pos);
    if (pos + CHUNK_LINES >= totalLines) {
      break;
    }
    pos += CHUNK_LINES - CHUNK_OVERLAP;
  }

  const totalChunks = starts.length;

  return starts.map((start, index) => {
    const end = Math.min(start + CHUNK_LINES - 1, totalLines - 1); // 0-based inclusive
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
  if (error) {
    return `<search_result uri="${uri}" pattern="${pattern}" case_sensitive="${mode}" count="0" error="${error}">\n(search failed: ${error})\n</search_result>`;
  }
  const body = matches.length > 0 ? matches.join('\n') : '(no matches)';
  return `<search_result uri="${uri}" pattern="${pattern}" case_sensitive="${mode}" count="${matchCount}">\n${body}\n</search_result>`;
}

/**
 * Search a file or directory for a ripgrep pattern. Returns up to 50 matches with 2 lines of context.
 * When `globFilter` is provided, passes it via `--glob` so rg filters files within the directory.
 */
export async function searchFileWithRg(
  absolutePath: string,
  pattern: string,
  caseSensitive = true,
  globFilter?: string
): Promise<{ lines: string[]; matchCount: number; error?: string }> {
  const MAX_MATCHES = 50;
  const CONTEXT_LINES = 2;
  const MAX_RESULT_LINE_CHARS = 400;
  const TRUNCATED_SUFFIX = ' [truncated]';

  const truncateSearchLine = (line: string): string => {
    if (line.length <= MAX_RESULT_LINE_CHARS) {
      return line;
    }
    const keep = Math.max(0, MAX_RESULT_LINE_CHARS - TRUNCATED_SUFFIX.length);
    return line.slice(0, keep) + TRUNCATED_SUFFIX;
  };

  const renderMatchesWithContext = (rawLines: string[]): string[] => {
    const matchLineNumbers = rawLines
      .map(l => /^(\d+):/.exec(l)?.[1])
      .filter((v): v is string => typeof v === 'string')
      .map(v => Number(v))
      .filter(n => Number.isInteger(n) && n > 0);

    if (matchLineNumbers.length === 0) {
      // Fall back to raw ripgrep output when line number parsing fails
      // (e.g., when searching directories where rg outputs file paths before matches)
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
    const args = [
      '--line-number',
      '--no-heading',
      caseSensitive ? '--case-sensitive' : '--ignore-case',
      '--max-count', String(MAX_MATCHES),
      ...(globFilter ? ['--glob', globFilter] : []),
      '-e', pattern,
      absolutePath,
    ];
    let stdout = '';
    let stderr = '';
    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn(_rgPath, args);
    } catch (e) {
      resolve({ lines: [], matchCount: 0, error: `spawn failed: ${e}` });
      return;
    }
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      const rawLines = stdout.split('\n').filter(l => l.trim() !== '');
      const lines = renderMatchesWithContext(rawLines);
      const error = (code !== null && code > 1 && stderr.trim()) ? stderr.trim() : undefined;
      resolve({ lines, matchCount: rawLines.length, error });
    });
    proc.on('error', (e) => resolve({ lines: [], matchCount: 0, error: `process error: ${e}` }));
    setTimeout(() => { proc.kill(); resolve({ lines: [], matchCount: 0, error: 'timeout' }); }, 2000);
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
  maxChunks = 2
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
      proc = cp.spawn(_rgPath, args);
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
