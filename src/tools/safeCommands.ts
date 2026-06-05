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
