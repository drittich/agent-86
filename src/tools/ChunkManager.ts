import * as crypto from 'crypto';
import { extractJsonCandidates } from './editParser';

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
