import { spawn } from 'child_process';

/** Maximum bytes captured from stdout + stderr combined. */
const OUTPUT_CAP_BYTES = 32 * 1024; // 32 KB

/** Maximum milliseconds a command may run before being killed. */
const COMMAND_TIMEOUT_MS = 30_000; // 30 s

/**
 * @@RUN Structured Command Block Format
 * ======================================
 *
 * The model may include one or more `@@RUN` blocks in its assistant message to
 * request execution of a shell command. The extension host parses these blocks,
 * shows an approval card, and—after explicit user approval—executes the command
 * and feeds the result back to the model.
 *
 * ## Block syntax
 *
 * ```
 * @@RUN
 * <shell command>
 * @@END
 * ```
 *
 * Rules:
 *  - `@@RUN` — opens a block.
 *  - `@@END` — closes the block.
 *  - The command is the trimmed content between the markers (single line or
 *    multi-line; passed verbatim to the shell).
 *  - Commands are executed in the first workspace folder (the working directory).
 *  - stdout + stderr are captured and capped at 32 KB. Excess output is replaced
 *    with a truncation notice.
 *  - A 30-second timeout kills the process and reports a timeout error.
 *  - Multiple `@@RUN` blocks in a single message are processed in order.
 *
 * ## Example
 *
 * ```
 * @@RUN
 * npm test
 * @@END
 * ```
 */

export interface RunBlock {
  /** The shell command to execute, trimmed. */
  command: string;
}

export interface RunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True if output was truncated to fit the cap. */
  truncated: boolean;
  /** Set if the command was killed by the timeout. */
  timedOut: boolean;
}

const RUN_OPEN = '@@RUN';
const RUN_END = '@@END';

/**
 * Parse all `@@RUN` blocks from an assistant message.
 * Returns an array of RunBlock objects (empty if none found).
 */
export function parseRunBlocks(text: string): RunBlock[] {
  const lines = text.split('\n');
  const blocks: RunBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== RUN_OPEN) {
      i++;
      continue;
    }
    i++;

    const cmdLines: string[] = [];
    while (i < lines.length && lines[i].trimEnd() !== RUN_END) {
      cmdLines.push(lines[i]);
      i++;
    }

    if (i < lines.length) {
      i++; // consume @@END
    }

    const command = cmdLines.join('\n').trim();
    if (command) {
      blocks.push({ command });
    }
  }

  return blocks;
}

/**
 * Execute a shell command in `cwd`, capturing stdout + stderr up to
 * `OUTPUT_CAP_BYTES`. Kills the process after `COMMAND_TIMEOUT_MS`.
 *
 * Never throws — errors are reflected in the returned `RunResult`.
 */
export function runCommand(command: string, cwd: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;

    // Use the platform shell so that built-ins (cd, echo, etc.) work.
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWin ? '/c' : '-c';

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      windowsHide: true,
      // Merge stderr into a separate stream so we can label it.
    });

    function onData(data: Buffer): void {
      if (truncated) { return; }
      const remaining = OUTPUT_CAP_BYTES - totalBytes;
      if (data.length > remaining) {
        chunks.push(data.subarray(0, remaining));
        totalBytes += remaining;
        truncated = true;
      } else {
        chunks.push(data);
        totalBytes += data.length;
      }
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout?.on('data', (data: Buffer) => {
      onData(data);
      const rem = OUTPUT_CAP_BYTES - stdoutBytes;
      if (rem > 0) {
        stdoutChunks.push(data.subarray(0, rem));
        stdoutBytes += Math.min(data.length, rem);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      onData(data);
      const rem = OUTPUT_CAP_BYTES - stderrBytes;
      if (rem > 0) {
        stderrChunks.push(data.subarray(0, rem));
        stderrBytes += Math.min(data.length, rem);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      void chunks; // suppress unused warning — we track per-stream above

      let stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (truncated) {
        const notice = '\n[...output truncated at 32 KB...]';
        // Append to whichever stream has content, or stdout.
        if (stderr.length > 0) {
          stderr += notice;
        } else {
          stdout += notice;
        }
      }

      resolve({ command, exitCode, stdout, stderr, truncated, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: null,
        stdout: '',
        stderr: `Failed to start process: ${err.message}`,
        truncated: false,
        timedOut: false,
      });
    });
  });
}

/**
 * Format a RunResult as a compact summary to feed back to the model.
 */
export function formatRunResult(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`@@RUN_RESULT command: ${result.command}`);

  if (result.timedOut) {
    lines.push('status: timed out (killed after 30s)');
  } else {
    lines.push(`exit_code: ${result.exitCode ?? 'null'}`);
  }

  if (result.stdout) {
    lines.push('stdout:');
    lines.push(result.stdout);
  }
  if (result.stderr) {
    lines.push('stderr:');
    lines.push(result.stderr);
  }
  if (!result.stdout && !result.stderr) {
    lines.push('(no output)');
  }

  return lines.join('\n');
}
