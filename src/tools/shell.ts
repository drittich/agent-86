import * as vscode from 'vscode';
import { execFileSync } from 'child_process';

/**
 * Shell selection for the execute_bash tool.
 *
 * The user's configured shell (agent86.shell) drives both how commands are
 * spawned and the command guidance injected into the prompt. 'auto' prefers
 * PowerShell 7+ (pwsh) → Windows PowerShell (powershell.exe) → cmd.exe on
 * Windows, and the system shell on POSIX.
 */

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'posix';
export type ShellPreference = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'bash';

export interface ResolvedShell {
  kind: ShellKind;
  /** Executable to spawn. */
  file: string;
  /** Build the spawn argv for a command string. */
  buildArgs: (command: string) => string[];
  /** Human-readable label for prompts / system info. */
  label: string;
  /** True for pwsh or powershell.exe. */
  isPowerShell: boolean;
}

/** Read the configured shell preference (defaults to 'auto'). */
export function getShellPreference(): ShellPreference {
  const pref = vscode.workspace.getConfiguration('agent86').get<string>('shell') ?? 'auto';
  if (pref === 'pwsh' || pref === 'powershell' || pref === 'cmd' || pref === 'bash') {
    return pref;
  }
  return 'auto';
}

/** True when `exe` resolves on PATH (cheap, cached per process). */
const _onPathCache = new Map<string, boolean>();
function isOnPath(exe: string): boolean {
  const cached = _onPathCache.get(exe);
  if (cached !== undefined) {
    return cached;
  }
  let found = false;
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(locator, [exe], { stdio: 'ignore' });
    found = true;
  } catch {
    found = false;
  }
  _onPathCache.set(exe, found);
  return found;
}

/**
 * PowerShell command builder. Uses -EncodedCommand (base64 of UTF-16LE) so
 * arbitrary multi-line commands need no quote-escaping, and appends
 * `exit $LASTEXITCODE` so a failing native exe surfaces a real exit code.
 */
function powerShellArgs(command: string): string[] {
  const wrapped = `${command}\nexit $LASTEXITCODE`;
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

function pwshShell(file: string, kind: 'pwsh' | 'powershell'): ResolvedShell {
  return {
    kind,
    file,
    buildArgs: powerShellArgs,
    label: kind === 'pwsh' ? 'PowerShell 7+ (pwsh)' : 'Windows PowerShell (powershell.exe)',
    isPowerShell: true,
  };
}

function cmdShell(): ResolvedShell {
  return {
    kind: 'cmd',
    file: 'cmd.exe',
    buildArgs: (command: string) => ['/c', command],
    label: 'Windows Command Prompt (cmd.exe)',
    isPowerShell: false,
  };
}

function posixShell(file = '/bin/sh'): ResolvedShell {
  return {
    kind: 'posix',
    file,
    buildArgs: (command: string) => ['-c', command],
    label: file,
    isPowerShell: false,
  };
}

let _cached: { pref: ShellPreference; platform: string; shell: ResolvedShell } | undefined;

/**
 * Resolve the shell to use for command execution, honoring the configured
 * preference and falling back gracefully when a chosen shell is unavailable.
 * Cached for the process (keyed by preference + platform).
 */
export function resolveShell(pref: ShellPreference = getShellPreference()): ResolvedShell {
  if (_cached && _cached.pref === pref && _cached.platform === process.platform) {
    return _cached.shell;
  }

  const isWin = process.platform === 'win32';
  let shell: ResolvedShell;

  if (pref === 'bash') {
    shell = posixShell(isOnPath('bash') ? 'bash' : '/bin/sh');
  } else if (pref === 'cmd') {
    shell = isWin ? cmdShell() : posixShell();
  } else if (pref === 'pwsh') {
    shell = isOnPath('pwsh') ? pwshShell('pwsh', 'pwsh') : (isWin ? pwshShell('powershell.exe', 'powershell') : posixShell());
  } else if (pref === 'powershell') {
    shell = isWin ? pwshShell('powershell.exe', 'powershell') : (isOnPath('pwsh') ? pwshShell('pwsh', 'pwsh') : posixShell());
  } else {
    // auto
    if (isOnPath('pwsh')) {
      shell = pwshShell('pwsh', 'pwsh');
    } else if (isWin) {
      shell = pwshShell('powershell.exe', 'powershell');
    } else {
      shell = posixShell(process.env.SHELL || '/bin/sh');
    }
  }

  _cached = { pref, platform: process.platform, shell };
  return shell;
}
