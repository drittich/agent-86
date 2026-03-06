import * as fs from 'fs';
import * as path from 'path';

/**
 * Parses .gitignore files from workspace roots and provides an isIgnored()
 * check for workspace-relative paths (forward-slash separated).
 *
 * Handles the most common gitignore pattern syntax:
 *  - Blank lines / # comments are skipped
 *  - ! prefix negates a rule
 *  - Leading / anchors to workspace root
 *  - Trailing / marks a directory (matched as a path prefix)
 *  - * matches anything except /
 *  - ** matches anything including /
 *  - ? matches any single character except /
 */
export class GitIgnoreFilter {
  private rules: Array<{ regex: RegExp; negated: boolean }> = [];

  constructor(private readonly wsRoots: string[]) {
    this.load();
  }

  private load(): void {
    this.rules = [];
    for (const root of this.wsRoots) {
      const gitignorePath = path.join(root, '.gitignore');
      try {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        this.parseRules(content);
      } catch {
        // No .gitignore or unreadable — skip
      }
    }
  }

  private parseRules(content: string): void {
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) { continue; }

      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      const regex = this.patternToRegex(pattern);
      if (regex) {
        this.rules.push({ regex, negated });
      }
    }
  }

  private patternToRegex(rawPattern: string): RegExp | null {
    let p = rawPattern.trim();

    // Trailing / marks a directory pattern — strip it; the (?:/.*)? suffix handles children
    if (p.endsWith('/')) { p = p.slice(0, -1); }

    // Leading / anchors the pattern to the workspace root
    const anchored = p.startsWith('/');
    if (anchored) { p = p.slice(1); }

    // A pattern is implicitly root-anchored if it contains a / after removing **
    const rootAnchored = anchored || p.replace(/\*\*/g, '').includes('/');

    // Convert gitignore glob syntax to a regex string
    const regexPiece = p
      .replace(/[.+^${}()|\\]/g, '\\$&')  // escape regex special chars first
      .replace(/\*\*\//g, '(?:[^/]+/)*')   // **/ → zero-or-more path segments
      .replace(/\*\*/g, '.*')               // **  → anything (including /)
      .replace(/\*/g, '[^/]*')              // *   → anything except /
      .replace(/\?/g, '[^/]');              // ?   → one character except /

    const fullPattern = rootAnchored
      ? `^${regexPiece}(?:/.*)?$`
      : `(?:^|/)${regexPiece}(?:/.*)?$`;

    try {
      return new RegExp(fullPattern);
    } catch {
      return null;
    }
  }

  /**
   * Returns true if the given workspace-relative path should be excluded
   * according to the parsed .gitignore rules.
   *
   * Accepts both forward-slash and back-slash separators.
   */
  isIgnored(relativePath: string): boolean {
    const p = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    let ignored = false;
    for (const { regex, negated } of this.rules) {
      if (regex.test(p)) {
        ignored = !negated;
      }
    }
    return ignored;
  }

  /** Re-reads .gitignore files from disk (call if the file changes). */
  reload(): void {
    this.load();
  }
}
