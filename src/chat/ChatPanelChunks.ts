import * as vscode from 'vscode';
import * as path from 'path';
import {
  chunkFile, formatChunkBlock, buildChunkMeta, parseChunkRequests,
  parseFileRequests, formatFileListBlock,
  parseSearchRequests, formatSearchResultBlock, searchFileWithRg,
  extractPromptTokens, selectBestChunk, selectExactLineRangeChunks,
  chunkLinesForContext,
  normalizeFilePathKey, rangeIsCovered, describeUndeliveredRanges,
  FileChunkMeta, FileChunk, ChunkRequest, DeliveredRange,
} from '../tools/ChunkManager';
import { resolveEditPath } from '../tools/editParser';
import { FILE_EXCLUDE_GLOB, FILE_CAP_BYTES, TOTAL_CAP_BYTES } from '../tools/FileTools';

/** Normalize common incorrect file extensions in glob patterns. */
export function normalizeGlob(glob: string): string {
  return glob
    .replace(/\bc#\b/g, 'cs')     // C# → cs
    .replace(/\bc\+\+\b/g, 'cpp') // C++ → cpp
    .replace(/\bf#\b/g, 'fs');    // F# → fs
}

export interface ChunkManagerDeps {
  log: vscode.OutputChannel;
  getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[];
  postMessage: (message: unknown) => void;
  /** Active provider context window (tokens); drives context-aware chunk sizing. */
  getContextWindow: () => number;
}

export class ChatPanelChunks {
  /** Maps workspace-relative URI → chunk metadata for files chunked in the current session. */
  private _chunkMeta = new Map<string, FileChunkMeta>();

  constructor(private deps: ChunkManagerDeps) {}

  public get chunkMeta(): Map<string, FileChunkMeta> {
    return this._chunkMeta;
  }

  public set chunkMeta(value: Map<string, FileChunkMeta>) {
    this._chunkMeta = value;
  }

  /**
   * Resolve a workspace-relative path to an absolute path, with a
   * case-insensitive basename glob fallback if the exact path doesn't exist.
   * Returns { absolutePath, relativePath } or null if unresolvable.
   */
  async resolvePathWithFallback(
    relativePath: string,
    wsRoots: string[]
  ): Promise<{ absolutePath: string; relativePath: string } | null> {
    const pathResult = resolveEditPath(relativePath, wsRoots);
    if (!pathResult.error) {
      // Check it actually exists on disk
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(pathResult.resolvedPath!));
        return { absolutePath: pathResult.resolvedPath!, relativePath };
      } catch { /* fall through to glob */ }
    }

    // Glob fallback: match by basename (case-insensitive)
    const basename = path.basename(relativePath);
    const basenameLower = basename.toLowerCase();
    let uris: vscode.Uri[] = [];
    try { uris = await vscode.workspace.findFiles(`**/${basename}`, FILE_EXCLUDE_GLOB, 10); } catch { /* ignore */ }
    if (uris.length === 0) {
      try {
        const all = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE_GLOB, 500);
        uris = all.filter(u => path.basename(u.fsPath).toLowerCase() === basenameLower);
      } catch { /* ignore */ }
    }
    if (uris.length === 1) {
      const wsRoot = wsRoots[0] ?? '';
      const abs = uris[0].fsPath;
      const rel = abs.startsWith(wsRoot + path.sep)
        ? abs.slice(wsRoot.length + 1).replace(/\\/g, '/')
        : abs.replace(/\\/g, '/');
      this.deps.log.appendLine(`[resolve] "${relativePath}" → "${rel}" via glob fallback`);
      return { absolutePath: abs, relativePath: rel };
    }
    return null;
  }

  /**
   * Read, chunk, and cache metadata for a single file.
   * Returns the chunks array, or null if the file cannot be read.
   */
  async getChunksForUri(
    relativePath: string,
    wsRoots: string[]
  ): Promise<FileChunk[] | null> {
    const resolved = await this.resolvePathWithFallback(relativePath, wsRoots);
    if (!resolved) {
      this.deps.log.appendLine(`[chunks] could not read "${relativePath}" — file not found or outside workspace`);
      return null;
    }

    const { absolutePath, relativePath: resolvedRelativePath } = resolved;
    const fileUri = vscode.Uri.file(absolutePath);
    let content: string;
    let docVersion: number;
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      content = doc.getText();
      docVersion = doc.version;
    } catch {
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        content = Buffer.from(bytes).toString('utf8');
        docVersion = 0;
      } catch {
        this.deps.log.appendLine(`[chunks] could not read "${relativePath}"`);
        return null;
      }
    }

    const chunkLines = chunkLinesForContext(this.deps.getContextWindow());
    const chunks = chunkFile(resolvedRelativePath, content, docVersion, chunkLines);
    this._chunkMeta.set(resolvedRelativePath, buildChunkMeta(chunks));
    return chunks;
  }

  /**
   * Select chunks to fulfil a `request_chunks` request.
   * Supports either:
   * - `preferred.line_range` (exact inclusive lines, no overlap padding), or
   * - `preferred.near_line` (chunk window around a line).
   * Defaults to first N chunks.
   */
  selectChunksForRequest(
    chunks: FileChunk[],
    preferred?: ChunkRequest['preferred']
  ): FileChunk[] {
    const maxChunks = preferred?.max_chunks ?? 2;
    const lineRange = preferred?.line_range;
    if (lineRange) {
      const chunkLines = chunkLinesForContext(this.deps.getContextWindow());
      return selectExactLineRangeChunks(chunks, lineRange, maxChunks, chunkLines);
    }
    const nearLine = preferred?.near_line;
    if (!nearLine) {
      return chunks.slice(0, maxChunks);
    }
    // Find chunk whose lineStart is closest to nearLine
    let bestIdx = 0;
    let bestDist = Math.abs(chunks[0].lineStart - nearLine);
    for (let i = 1; i < chunks.length; i++) {
      const dist = Math.abs(chunks[i].lineStart - nearLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const half = Math.floor(maxChunks / 2);
    const start = Math.max(0, bestIdx - half);
    return chunks.slice(start, start + maxChunks);
  }

  /**
   * Process file requests from the model response.
   */
  async processFileRequests(
    fullResponse: string,
    wsRoots: string[],
    maxFileRounds: number,
    currentRound: number
  ): Promise<{ done: boolean; content?: string; nextRound: number }> {
    const fileRequests = parseFileRequests(fullResponse);
    if (!fileRequests || currentRound >= maxFileRounds) {
      return { done: true, nextRound: currentRound };
    }

    const nextRound = currentRound + 1;
    this.deps.log.appendLine(`[files] ${fileRequests.length} glob request(s), round ${nextRound}/${maxFileRounds}`);
    this.deps.postMessage({ type: 'status', text: `Searching ${fileRequests.length} glob pattern(s)…` });
    
    const parts: string[] = [];
    for (const req of fileRequests) {
      const normalizedGlob = normalizeGlob(req.glob);
      if (normalizedGlob !== req.glob) {
        this.deps.log.appendLine(`[files] normalized glob "${req.glob}" → "${normalizedGlob}"`);
      }
      this.deps.log.appendLine(`[files] glob="${normalizedGlob}" reason="${req.reason ?? ''}"`);
      
      let uris: vscode.Uri[] = [];
      try { uris = await vscode.workspace.findFiles(normalizedGlob, FILE_EXCLUDE_GLOB, 200); }
      catch (err) { this.deps.log.appendLine(`[files] findFiles error: ${err}`); }
      
      // Retry with case-insensitive basename matching if nothing matched
      if (uris.length === 0) {
        const basenameMatch = req.glob.match(/^(.*\/)([^/*]+)$/);
        if (basenameMatch) {
          const [, dir, base] = basenameMatch;
          const relaxed = `${dir}*`;
          const baseLower = base.toLowerCase();
          try {
            const all = await vscode.workspace.findFiles(relaxed, FILE_EXCLUDE_GLOB, 500);
            uris = all.filter(u => path.basename(u.fsPath).toLowerCase() === baseLower);
            if (uris.length > 0) {
              this.deps.log.appendLine(`[files] case-insensitive retry matched ${uris.length} file(s) for "${req.glob}"`);
            }
          } catch (err) { this.deps.log.appendLine(`[files] case-insensitive retry error: ${err}`); }
        }
      }
      
      const paths = uris.map(u => {
        for (const root of wsRoots) {
          if (u.fsPath.startsWith(root + path.sep) || u.fsPath === root) {
            return u.fsPath.slice(root.length + 1).replace(/\\/g, '/');
          }
        }
        return u.fsPath.replace(/\\/g, '/');
      }).sort();
      
      parts.push(formatFileListBlock(req.glob, paths));
      this.deps.log.appendLine(`[files] matched ${paths.length} file(s)`);
    }

    return { done: false, content: parts.join('\n\n'), nextRound };
  }

  /**
   * Process search requests from the model response.
   */
  async processSearchRequests(
    fullResponse: string,
    wsRoots: string[],
    maxSearchRounds: number,
    currentRound: number,
    enforceSearchFirst: boolean,
    searchFirstRedirects: number,
    maxSearchFirstRedirects: number
  ): Promise<{
    done: boolean;
    redirect?: boolean;
    content?: string;
    nextRound: number;
    nextRedirects: number;
  }> {
    const searchRequests = parseSearchRequests(fullResponse);
    
    // Check for redirect to search first
    if (searchRequests && enforceSearchFirst && currentRound < maxSearchRounds && searchFirstRedirects < maxSearchFirstRedirects) {
      return {
        done: false,
        redirect: true,
        nextRound: currentRound + 1,
        nextRedirects: searchFirstRedirects + 1
      };
    }

    if (!searchRequests || currentRound >= maxSearchRounds) {
      return { done: true, nextRound: currentRound, nextRedirects: searchFirstRedirects };
    }

    const nextRound = currentRound + 1;

    // Hard cap: avoid a model asking for many searches and inflating the next request.
    const MAX_SEARCH_REQUESTS_PER_ROUND = 2;
    const effectiveSearchRequests = searchRequests.slice(0, MAX_SEARCH_REQUESTS_PER_ROUND);
    const capped = effectiveSearchRequests.length !== searchRequests.length;

    this.deps.log.appendLine(
      `[search] round ${nextRound}/${maxSearchRounds}, ${effectiveSearchRequests.length}/${searchRequests.length} request(s)` +
      (capped ? ' (capped)' : '')
    );
    this.deps.postMessage({ type: 'status', text: `Searching ${effectiveSearchRequests.length} file(s)…` });

    const parts: string[] = [];
    for (const req of effectiveSearchRequests) {
      const caseSensitive = req.caseSensitive ?? true;
      const isGlob = /[*?{]/.test(req.uri);
      let absolutePath: string;
      let displayUri: string;
      let globFilter: string | undefined;
      
      if (isGlob) {
        // Extract the non-glob prefix directory
        const slashIdx = req.uri.search(/[*?{]/);
        const prefix = req.uri.slice(0, slashIdx).replace(/[\\/]+$/, '');
        const wsRoot = wsRoots[0] ?? '';
        absolutePath = prefix ? path.join(wsRoot, prefix) : wsRoot;
        
        // Verify the directory exists; fall back to workspace root
        try { await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath)); }
        catch { absolutePath = wsRoot; }
        
        // Only pass --glob if the pattern specifies a file extension filter
        globFilter = /\.\w+$/.test(req.uri) ? req.uri : undefined;
        displayUri = req.uri;
      } else {
        const resolved = await this.resolvePathWithFallback(req.uri, wsRoots);
        absolutePath = resolved?.absolutePath ?? path.join(wsRoots[0] ?? '', req.uri);
        displayUri = resolved?.relativePath ?? req.uri;
      }

      // Directory-wide searches: apply a conservative default file glob
      if (!globFilter) {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
          if (stat.type === vscode.FileType.Directory) {
            globFilter = '**/*.{ts,tsx,js,jsx,mjs,cjs,cs,py,java,kt,go,rs,cpp,c,h,hpp,fs,fsx}';
            this.deps.log.appendLine(`[search] default globFilter applied for directory search: ${globFilter}`);
          }
        } catch {
          // ignore
        }
      }

      let { lines: matches, matchCount, error: searchError } = await searchFileWithRg(
        absolutePath,
        req.pattern,
        caseSensitive,
        globFilter
      );

      // For directory searches, prefix paths back to workspace-relative
      if (isGlob && matches.length > 0) {
        const base = displayUri.slice(0, displayUri.search(/[*?{]/)).replace(/[\\/]+$/, '').replace(/\\/g, '/');
        if (base) {
          matches = matches.map((l) => {
            const t = l.trim();
            if (!t || t.startsWith('(') || t.startsWith('<') || t.startsWith('@') || t.startsWith('>')) {
              return l;
            }
            if (t.includes(':')) {
              return l;
            }
            if (t.startsWith(base + '/')) {
              return t;
            }
            return `${base}/${t}`;
          });
        }
      }

      if (searchError) {
        this.deps.log.appendLine(`[search] rg error for "${displayUri}": ${searchError}`);
      }
      this.deps.log.appendLine(
        `[search] "${req.pattern}" in ${displayUri} (${absolutePath})` +
        ` [case_sensitive=${caseSensitive}] → ${matchCount} match(es)` +
        `${searchError ? ' (error)' : ''}`
      );
      parts.push(formatSearchResultBlock(displayUri, req.pattern, matches, matchCount, searchError, caseSensitive));
    }

    if (capped) {
      parts.push(
        `<tool_note>Search requests capped to ${MAX_SEARCH_REQUESTS_PER_ROUND} per round to stay within context budget.</tool_note>`
      );
    }

    return { done: false, content: parts.join('\n\n'), nextRound, nextRedirects: searchFirstRedirects };
  }

  /**
   * Process chunk requests from the model response.
   */
  async processChunkRequests(
    fullResponse: string,
    wsRoots: string[],
    maxChunkRounds: number,
    currentRound: number,
    deliveredRanges: Map<string, DeliveredRange[]>,
    maxChunkNoOpRounds: number,
    currentNoOpRounds: number
  ): Promise<{
    done: boolean;
    noOp: boolean;
    content?: string;
    nextRound: number;
    nextNoOpRounds: number;
  }> {
    const chunkRequests = parseChunkRequests(fullResponse);

    if (!chunkRequests) {
      return { done: true, noOp: false, nextRound: currentRound, nextNoOpRounds: currentNoOpRounds };
    }

    if (currentRound >= maxChunkRounds) {
      this.deps.log.appendLine(`[chunks] retry limit reached`);
      this.deps.postMessage({ type: 'status', text: 'Chunk request limit reached. Try attaching more of the file manually.' });
      return { done: true, noOp: false, nextRound: currentRound, nextNoOpRounds: currentNoOpRounds };
    }

    const nextRound = currentRound + 1;
    this.deps.log.appendLine(
      `[chunks] model requested ${chunkRequests.length} chunk(s), round ${nextRound}/${maxChunkRounds}`
    );
    this.deps.postMessage({ type: 'status', text: `Fetching ${chunkRequests.length} requested chunk(s)…` });

    const parts: string[] = [];
    // Reasons no content was sent, for precise no-op guidance.
    const notFound: string[] = [];
    const alreadyHave: Array<{ uri: string; totalLines: number }> = [];

    const recordDelivered = (uri: string, start: number, end: number): void => {
      const key = normalizeFilePathKey(uri);
      if (!deliveredRanges.has(key)) { deliveredRanges.set(key, []); }
      deliveredRanges.get(key)!.push({ start, end });
    };

    for (const req of chunkRequests) {
      const chunks = await this.getChunksForUri(req.uri, wsRoots);
      if (!chunks) {
        this.deps.log.appendLine(`[chunks] could not read "${req.uri}" — file not found or ambiguous`);
        notFound.push(req.uri);
        continue;
      }

      const totalLines = chunks[chunks.length - 1]?.lineEnd ?? 0;
      const maxNew = req.preferred?.max_chunks ?? 2;
      let newSent = 0;
      const selected = this.selectChunksForRequest(chunks, req.preferred);
      if (req.preferred?.line_range) {
        const { start, end } = req.preferred.line_range;
        this.deps.log.appendLine(`[chunks] using line_range ${start}-${end} for "${req.uri}"`);
      }

      let sentForThisReq = 0;
      const key = normalizeFilePathKey(req.uri);
      for (const chunk of selected) {
        if (rangeIsCovered(deliveredRanges.get(key), chunk.lineStart, chunk.lineEnd)) {
          this.deps.log.appendLine(`[chunks] skipping already-delivered ${chunk.uri} ${chunk.lineStart}-${chunk.lineEnd}`);
          continue;
        }
        if (newSent >= maxNew) {
          this.deps.log.appendLine(`[chunks] max_chunks cap (${maxNew}) reached for "${req.uri}"`);
          break;
        }
        recordDelivered(req.uri, chunk.lineStart, chunk.lineEnd);
        parts.push(formatChunkBlock(chunk));
        this.deps.log.appendLine(`[chunks] sending ${chunk.uri} lines ${chunk.lineStart}-${chunk.lineEnd} (total=${chunk.totalChunks})`);
        newSent++;
        sentForThisReq++;
      }
      if (sentForThisReq === 0) {
        alreadyHave.push({ uri: req.uri, totalLines });
      }
    }

    if (parts.length === 0) {
      const nextNoOpRounds = currentNoOpRounds + 1;
      this.deps.log.appendLine(`[chunks] no new chunks to send (noop ${nextNoOpRounds}/${maxChunkNoOpRounds})`);
      this.deps.postMessage({
        type: 'status',
        text: 'No new chunks to send — requested content is already in context or the path was not found.',
      });

      if (nextNoOpRounds >= maxChunkNoOpRounds) {
        return { done: true, noOp: false, nextRound, nextNoOpRounds };
      }

      return {
        done: false,
        noOp: true,
        content: this._buildNoOpGuidance(notFound, alreadyHave, deliveredRanges),
        nextRound,
        nextNoOpRounds
      };
    }

    return { done: false, noOp: false, content: parts.join('\n\n'), nextRound, nextNoOpRounds: 0 };
  }

  /**
   * Build precise guidance when a chunk request yielded no new content,
   * distinguishing already-delivered files (with the ranges still missing) from
   * paths that could not be resolved.
   */
  private _buildNoOpGuidance(
    notFound: string[],
    alreadyHave: Array<{ uri: string; totalLines: number }>,
    deliveredRanges: Map<string, DeliveredRange[]>
  ): string {
    const lines: string[] = [];
    for (const { uri, totalLines } of alreadyHave) {
      const undelivered = describeUndeliveredRanges(deliveredRanges.get(normalizeFilePathKey(uri)), totalLines);
      if (undelivered) {
        lines.push(`${uri}: the requested lines are already in context above. Not yet delivered: ${undelivered}. ` +
          `Request one of those ranges with preferred.line_range to get new content.`);
      } else {
        lines.push(`${uri}: the entire file (${totalLines} line(s)) is already in context above — use it directly.`);
      }
    }
    for (const uri of notFound) {
      lines.push(`${uri}: could not be resolved (not found, ambiguous basename, or outside the workspace). ` +
        `Provide a more specific workspace-relative path.`);
    }
    return `<tool_guidance>No new content was sent.\n${lines.join('\n')}</tool_guidance>`;
  }

  /**
   * Prepare file chunks for initial user message injection.
   */
  async prepareFileChunks(
    newFiles: AttachedFile[],
    wsRoots: string[],
    prompt: string,
    autoDetectedThisTurnUris: Set<string>,
    maxInjectedChars: number,
    log: vscode.OutputChannel
  ): Promise<{
    chunkBlocks: string[];
    resolvedPaths: string[];
    skippedDueToInjectionCap: string[];
  }> {
    const chunkBlocks: string[] = [];
    const resolvedPaths: string[] = [];
    const skippedDueToInjectionCap: string[] = [];
    const promptTokens = extractPromptTokens(prompt);
    const wsRoot = wsRoots[0] ?? '';
    let injectedChars = 0;

    for (const f of newFiles) {
      if (injectedChars >= maxInjectedChars) {
        log.appendLine(`[chunks] injection cap reached (${maxInjectedChars} chars) — skipping remaining attached files`);
        skippedDueToInjectionCap.push(f.relativePath);
        continue;
      }

      const chunks = await this.getChunksForUri(f.relativePath, wsRoots);
      let block: string | null = null;

      if (chunks && chunks.length > 0) {
        if (autoDetectedThisTurnUris.has(f.uri)) {
          const absolutePath = path.join(wsRoot, f.relativePath);
          this.deps.postMessage({ type: 'status', text: `Searching ${f.relativePath}…` });
          const best = await selectBestChunk(chunks, absolutePath, promptTokens);
          block = formatChunkBlock(best);
          log.appendLine(`[chunks] sending ${best.uri} lines ${best.lineStart}-${best.lineEnd} (rg-scored, total=${best.totalChunks})`);
        } else {
          const first = chunks[0];
          block = formatChunkBlock(first);
          log.appendLine(`[chunks] sending ${first.uri} lines ${first.lineStart}-${first.lineEnd} (manual attach, initial=1, total=${first.totalChunks})`);
        }
      } else {
        // Fallback for unreadable/unsaved files
        block = `<file path="${f.relativePath}" language="${f.languageId}">\n${f.content}\n</file>`;
      }

      if (!block) {
        continue;
      }

      if (injectedChars + block.length > maxInjectedChars) {
        log.appendLine(`[chunks] skipping ${f.relativePath} — would exceed injection cap (${maxInjectedChars} chars)`);
        skippedDueToInjectionCap.push(f.relativePath);
        continue;
      }

      chunkBlocks.push(block);
      injectedChars += block.length;
      resolvedPaths.push(`  - ${f.relativePath}`);
    }

    return { chunkBlocks, resolvedPaths, skippedDueToInjectionCap };
  }
}

export interface AttachedFile {
  uri: string;
  relativePath: string;
  content: string;
  sizeBytes: number;
  languageId: string;
}