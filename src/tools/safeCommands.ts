/**
 * Classifies terminal commands so the agent can run read-only / harmless ones
 * without an approval gate, while still gating anything that can mutate state.
 *
 * Conservative by design: a command is only treated as safe when it has no
 * shell operators (pipes, redirection, chaining, command substitution) AND its
 * program is on an explicit allowlist (or its sub-command is, for tools like
 * git). Everything else falls through to the normal approval flow.
 */

/** Operators that can chain, redirect, or expand a command into something unsafe. */
const SHELL_OPERATOR = /[|&;<>`]|\$\(|\$\{|\n/;

/** Programs that only read state, regardless of their arguments. */
const SAFE_PROGRAMS = new Set([
  // file viewing
  'type', 'cat', 'bat', 'nl', 'more',
  // listing
  'ls', 'dir', 'tree', 'vdir',
  // path / environment introspection
  'pwd', 'cd', 'whoami', 'hostname', 'date', 'echo', 'where', 'which',
  // text inspection (read-only)
  'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'sort',
  // file metadata (read-only)
  'stat', 'file',
  // PowerShell read-only cmdlets + aliases (single-stage; pipelines still gate
  // via SHELL_OPERATOR, which catches `|`).
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi',
  'get-location', 'gl', 'get-command', 'gcm', 'get-help', 'get-member', 'gm',
  'test-path', 'resolve-path', 'select-string', 'sls', 'measure-object',
]);

/**
 * Programs whose safety depends on the sub-command. Maps a program to the set
 * of sub-commands that only read state. (`find` is deliberately excluded — its
 * POSIX form supports -delete / -exec.)
 */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'describe',
    'ls-files', 'ls-tree', 'shortlog', 'reflog', 'cat-file', 'whatchanged',
  ]),
  npm: new Set(['ls', 'list', 'view', 'outdated', 'ping', 'why', 'fund']),
  docker: new Set(['ps', 'images', 'version', 'info']),
};

/** When these are the ONLY arguments, any program is harmless to invoke. */
const VERSION_HELP_FLAGS = new Set([
  '--version', '-v', '-V', '--help', '-h', 'version', '--info', '--list-sdks',
]);

/** Multi-purpose tools whose allow-key should include the sub-command. */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'dotnet', 'docker', 'cargo', 'go', 'gh',
  'kubectl', 'pip', 'pip3', 'python', 'python3', 'node', 'npx', 'make',
]);

/** Split a command into tokens, honouring simple single/double quoting. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

/** Reduce a program token to its bare, lowercased name (strip path + `.exe`). */
function programName(token: string): string {
  let p = token.replace(/^["']|["']$/g, '');
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (slash >= 0) { p = p.slice(slash + 1); }
  return p.toLowerCase().replace(/\.exe$/, '');
}

/** The first non-flag argument, lowercased (a tool's sub-command). */
function firstSubcommand(rest: string[]): string | undefined {
  return rest.find(a => !a.startsWith('-'))?.toLowerCase();
}

/**
 * True when the command only reads state and is therefore safe to run without
 * an approval gate.
 */
export function isReadOnlySafe(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_OPERATOR.test(trimmed)) { return false; }

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) { return false; }

  const prog = programName(tokens[0]);
  const rest = tokens.slice(1);

  // `<anything> --version` / `--help` etc. is harmless.
  if (rest.length > 0 && rest.every(a => VERSION_HELP_FLAGS.has(a.toLowerCase()))) {
    return true;
  }

  if (SAFE_PROGRAMS.has(prog)) { return true; }

  const subs = SAFE_SUBCOMMANDS[prog];
  if (subs) {
    const sub = firstSubcommand(rest);
    if (sub && subs.has(sub)) { return true; }
  }

  return false;
}

/**
 * A stable, human-meaningful label for the command's "family" — the program,
 * plus its sub-command for multi-purpose tools (e.g. `git status`, `npm test`).
 * Used as the unit for persistent "always allow".
 */
export function commandFamily(command: string): string {
  const tokens = tokenize(command.trim());
  if (tokens.length === 0) { return ''; }

  const prog = programName(tokens[0]);
  if (SUBCOMMAND_TOOLS.has(prog)) {
    const sub = firstSubcommand(tokens.slice(1));
    if (sub) { return `${prog} ${sub}`; }
  }
  return prog;
}

/** The persistent allow-list key for a command (scoped to its family). */
export function commandAllowKey(command: string): string {
  return `runCommand:${commandFamily(command)}`;
}

/** Shell kinds the correction layer distinguishes. */
export type CorrectionShellKind = 'pwsh' | 'powershell' | 'cmd' | 'posix';

/**
 * POSIX programs that don't exist (or behave differently) under Windows cmd.exe,
 * mapped to the preferred Windows command and/or native tool. `cat`/`ls`/`grep`
 * may exist via Git/coreutils, but the native tools are always the better path.
 */
const CMD_CORRECTIONS: Record<string, string> = {
  cat:   'Use the `read_file` tool to read files (preferred), or the Windows `type` command.',
  ls:    'Use the `list_directory` tool, or the Windows `dir` command.',
  ll:    'Use the `list_directory` tool, or the Windows `dir` command.',
  grep:  'Use the `search_file_contents` tool, or the Windows `findstr` command.',
  egrep: 'Use the `search_file_contents` tool, or the Windows `findstr` command.',
  fgrep: 'Use the `search_file_contents` tool, or the Windows `findstr` command.',
  cp:    'Use the `copy_file` tool, or the Windows `copy` command.',
  mv:    'Use the `move_file` tool, or the Windows `move` command.',
  rm:    'Use the `delete_file` tool, or the Windows `del` (files) / `rmdir /s` (directories) command.',
  pwd:   'Use the Windows `cd` command (prints the current directory) or `echo %cd%`.',
  which: 'Use the Windows `where` command.',
  touch: 'Use the `write_file` tool to create a file, or `type nul > filename`.',
  clear: 'Use the Windows `cls` command.',
  man:   'Use `<command> /?` for help on Windows.',
  head:  'Use the `read_file` tool with a line range; cmd.exe has no `head`.',
  tail:  'Use the `read_file` tool with a line range; cmd.exe has no `tail`.',
};

/**
 * Commands with no PowerShell equivalent (alias or cmdlet). Note that PowerShell
 * DOES alias cat/ls/cp/mv/rm/pwd/clear/cd → so those are intentionally absent
 * here: refusing them would be wrong. Only genuinely-missing commands are listed.
 */
const POWERSHELL_CORRECTIONS: Record<string, string> = {
  grep:  'Use the `search_file_contents` tool, or PowerShell `Select-String` (alias `sls`).',
  egrep: 'Use the `search_file_contents` tool, or PowerShell `Select-String`.',
  fgrep: 'Use the `search_file_contents` tool, or PowerShell `Select-String -SimpleMatch`.',
  head:  'Use the `read_file` tool with a line range, or `Get-Content file -TotalCount N`.',
  tail:  'Use the `read_file` tool with a line range, or `Get-Content file -Tail N`.',
  touch: 'Use the `write_file` tool to create a file, or `New-Item -ItemType File <name>`.',
  which: 'Use PowerShell `Get-Command <name>` (alias `gcm`).',
  man:   'Use PowerShell `Get-Help <command>`.',
};

/** POSIX `find` flags that indicate the file-finder (vs Windows `find`, a text search). */
const POSIX_FIND_FLAGS = /(?:^|\s)-(?:name|iname|type|path|maxdepth|mindepth|exec|delete)\b/;

function correctionMessage(prog: string, shellLabel: string, suggestion: string): string {
  return `Refused: \`${prog}\` does not work in ${shellLabel}. ${suggestion} Re-issue the command using the suggested approach.`;
}

/**
 * Returns a corrective message when the command leads with a tool that won't
 * work in the active shell, so the model can self-correct from the tool result.
 * Returns null when the command is fine to run.
 *
 * Shell-aware: under PowerShell, POSIX aliases (cat/ls/rm/…) work and are NOT
 * refused; only genuinely-missing commands are corrected. Under cmd.exe, the
 * classic POSIX→Windows guidance applies. POSIX shells get no corrections.
 */
export function shellCommandCorrection(command: string, shell: CorrectionShellKind): string | null {
  if (shell === 'posix') { return null; }

  const tokens = tokenize(command.trim());
  if (tokens.length === 0) { return null; }

  const prog = programName(tokens[0]);
  const isPowerShell = shell === 'pwsh' || shell === 'powershell';
  const shellLabel = isPowerShell ? 'PowerShell' : 'this shell (cmd.exe)';

  // POSIX `find` (the file-finder) works in neither cmd.exe nor PowerShell.
  if (prog === 'find' && POSIX_FIND_FLAGS.test(command)) {
    return correctionMessage(
      'find',
      shellLabel,
      'Use the `find_files` tool (glob) or `search_file_contents`. Windows `find` is a text search, not a file finder — POSIX flags like `-name`/`-type` will not work.'
    );
  }

  const map = isPowerShell ? POWERSHELL_CORRECTIONS : CMD_CORRECTIONS;
  const suggestion = map[prog];
  return suggestion ? correctionMessage(prog, shellLabel, suggestion) : null;
}

/** @deprecated Use shellCommandCorrection(command, 'cmd'). Kept for callers/tests. */
export function windowsCommandCorrection(command: string): string | null {
  return shellCommandCorrection(command, 'cmd');
}
