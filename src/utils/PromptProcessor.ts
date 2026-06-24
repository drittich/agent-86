import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { resolveShell } from '../tools/shell';

/**
 * Get a label for the shell that the execute_bash tool will actually use,
 * honoring the agent86.shell preference (auto → pwsh → powershell → cmd).
 */
function getDefaultShell(): string {
  return resolveShell().label;
}

/**
 * Shell-specific command guidance for the active shell, so the model emits
 * commands that work in the shell execute_bash actually spawns.
 */
function shellGuidance(): string {
  const shell = resolveShell();
  if (shell.isPowerShell) {
    return (
      'You are using PowerShell. Use PowerShell cmdlets/aliases — `Get-ChildItem` (dir/ls), ' +
      '`Get-Content` (cat/type), `Select-String` (grep), `Copy-Item`, `Move-Item`, `Remove-Item`, ' +
      '`Test-Path`, `New-Item`. POSIX aliases (`cat`, `ls`, `rm`, `cp`, `mv`, `pwd`) also work. ' +
      'There is no `head`/`tail`/`touch`/`which` — use `Get-Content -TotalCount/-Tail N`, ' +
      '`New-Item`, and `Get-Command`. Chain steps with `;` (or `&&` in pwsh 7+); run in a ' +
      "subdirectory with `Set-Location 'C:\\full\\path'; <command>`."
    );
  }
  if (shell.kind === 'cmd') {
    return (
      'You are on Windows (cmd.exe). Use Windows commands (`type`, `dir`, `findstr`, `copy`, ' +
      '`move`, `del`) — NOT POSIX equivalents (`cat`, `ls`, `grep`, `cp`, `mv`, `rm`). ' +
      'Run in a subdirectory with `cd /d "C:\\full\\path" && command` (the `/d` switch is ' +
      'required to change drives).'
    );
  }
  return `You are using ${shell.label}. Use POSIX commands.`;
}

/**
 * Get a human-readable OS name
 */
function getOSName(): string {
  const plat = process.platform;
  switch (plat) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return plat;
  }
}

/**
 * Generate system information string
 */
function generateSystemInfo(): string {
  // NOTE: deliberately no clock time here. The system prompt is the cached
  // prefix of every request; a time-of-day string changes the prefix and
  // collapses the provider's prompt-cache hit rate to ~0%. Date is included at
  // day granularity (a stable prefix within a day, useful to the model) — drop
  // it too if you want a prefix that survives across days.
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  // Use the workspace root when available so the prompt reflects the active project.
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  return `Operating System: ${getOSName()}
OS Version: ${os.release()}
Platform: ${process.platform}
Default Shell: ${getDefaultShell()}
Home Directory: ${os.homedir()}
Current Working Directory: ${wsRoot}
Current Date: ${dateStr}

Shell usage: ${shellGuidance()}`;
}

/**
 * An explicit, OS-tailored note steering shell usage toward the right commands
 * for the current platform. Used to harden the inline fallback prompt.
 */
function environmentSection(): string {
  return `## Environment

${generateSystemInfo()}

Prefer native tools (\`read_file\`, \`search_file_contents\`, \`list_directory\`) over shell ` +
    `commands for reading, searching, and listing files. When you must use \`execute_bash\`, ` +
    `tailor commands to the shell shown above.`;
}

/**
 * Inject system information into the prompt template
 */
function injectSystemInfo(prompt: string): string {
  const systemInfo = generateSystemInfo();

  return prompt.replace(
    /<!-- DYNAMIC_SYSTEM_INFO_START -->[\s\S]*?<!-- DYNAMIC_SYSTEM_INFO_END -->/,
    systemInfo,
  );
}

/**
 * Get the path to the system prompt file. Prefers a per-project override in the
 * opened workspace, then falls back to the prompt bundled with the extension so
 * the OS-aware template is used regardless of which project is open.
 */
function getPromptPath(extensionPath?: string): string | undefined {
  const candidates: string[] = [];

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    candidates.push(path.join(wsRoot, 'prompts', 'system-prompt.md'));
  }
  if (extensionPath) {
    candidates.push(path.join(extensionPath, 'prompts', 'system-prompt.md'));
  }

  return candidates.find(p => fs.existsSync(p));
}

/**
 * Process the system prompt template by injecting dynamic system info.
 * @param extensionPath Absolute path to the extension install dir, used to find
 *   the bundled prompt when the workspace has no override.
 */
export function getSystemPrompt(extensionPath?: string): string {
  const promptPath = getPromptPath(extensionPath);

  if (promptPath) {
    try {
      const prompt = fs.readFileSync(promptPath, 'utf-8');
      return injectSystemInfo(prompt);
    } catch (error) {
      console.error(`Failed to load system prompt from ${promptPath}:`, error);
    }
  }

  // Fallback to inline prompts (original behavior)
  return '';
}

/**
 * Load a model-profile delta fragment from `prompts/profiles/<key>.md`.
 * Prefers a per-project override in the opened workspace, then the fragment
 * bundled with the extension. Returns an empty string when none exists so
 * non-DeepSeek providers carry no extra prompt weight.
 */
export function getProfilePrompt(profileKey: string, extensionPath?: string): string {
  const candidates: string[] = [];
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    candidates.push(path.join(wsRoot, 'prompts', 'profiles', `${profileKey}.md`));
  }
  if (extensionPath) {
    candidates.push(path.join(extensionPath, 'prompts', 'profiles', `${profileKey}.md`));
  }

  const profilePath = candidates.find(p => fs.existsSync(p));
  if (profilePath) {
    try {
      return fs.readFileSync(profilePath, 'utf-8').trim();
    } catch (error) {
      console.error(`Failed to load profile prompt from ${profilePath}:`, error);
    }
  }
  return '';
}

/**
 * Get the native tools system prompt (used when the model supports native tool calling)
 */
export function getNativeToolsPrompt(agentsMdSection: string, behaviorInstructions: string): string {
  return `You are a VS Code coding assistant.${agentsMdSection}

${behaviorInstructions}

${environmentSection()}

## Files
Files arrive as \`<file_chunk path lines="A-B" …>\` blocks holding the verbatim lines A–B — content is never summarized or truncated mid-file. Each delivery ends with a footer:
- \`<file_complete total_lines=L … />\` — the whole file is now in context.
- \`<file_more total_lines=L delivered="A-B" next='read_file(path=…, start_line=B+1)' />\` — more remains; make exactly the \`next\` call to page forward.
Follow the \`next\` hint to read large files page by page. Never shell out (e.g. \`execute_bash\`/\`Get-Content\`) to read file content — \`read_file\` returns it verbatim. When \`<resolved_paths>\` is present, use those exact paths in tool calls.

## Tools
 Use the provided tools to read files, make edits, run commands, and search. Prefer \`search_file_contents\` to verify usages before reading file sections. Use \`read_file\` with a line range when you need a specific section, and follow the \`<file_more>\` footer to page through the rest. Use \`string_replace\` for targeted edits.

 ## Investigation strategy
 For broad repository requests (performance, bugs, architecture, feature planning):
 - Start with \`search_file_contents\` using relevant keywords — do NOT start with \`list_directory\` or \`find_files\`.
 - After search results, read one high-confidence file immediately.
 - After each tool result, either call one concrete next tool OR answer directly.
 - Never return an empty response after tool results.

 ## Discovery (fallback only)
 Use \`find_files\` (recursive glob) or \`list_directory\` (one directory level) only when:
 - All targeted searches returned zero results.
 - The task explicitly asks for directory structure.
 - The repository structure is genuinely unknown and no keyword search is possible.
 Prefer app-owned paths (e.g. \`src/\`, \`server/\`, \`client/\`, \`app/\`) over broad workspace-wide globs.

 ## When to stop calling tools
 After reading 2-3 relevant files, synthesize findings and answer directly.
 Do not keep calling tools once sufficient evidence exists.`;
}

/**
 * Reference card for the legacy (non-native-tool) textual formats.
 *
 * Injected as an internal user message when the runtime falls back to legacy
 * parsing — either because the cached verdict for the model is legacy, or
 * because the provider rejected the tools parameter mid-turn. Keeping this out
 * of the stable system prompt avoids paying its token cost (and risking format
 * confusion) on models that support native tool calling.
 *
 * The leading marker is used to detect whether the reference has already been
 * injected into the session history.
 */
export const LEGACY_FORMAT_REFERENCE_MARKER = '[Fallback formats]';

export function getLegacyFormatReference(): string {
  return `${LEGACY_FORMAT_REFERENCE_MARKER} Native tool calling is unavailable for this model. Use the exact textual formats below instead. Never mix these with native tool-call syntax.

## Requesting data

If the relevant files are unknown, prefer \`request_files\` with \`**\` globs (e.g. \`src/**/*.ts\`, \`**/*.cs\`) rather than root-only \`*\`. Ignored files and folders are excluded automatically.

Emit ONE of these JSON objects instead of \`edits\` (max 2 rounds each; do not combine with \`edits\` or each other):

**Search file:** \`{"search_file":[{"uri":"src/foo.ts","pattern":"MyImport","case_sensitive":false,"reason":"…"}]}\` → returns \`<search_result uri pattern case_sensitive count>\` with each hit plus nearby context lines. Omit \`case_sensitive\` or set \`false\` when case may vary; set \`true\` for exact-case matching. Use this to find identifier usages across a whole file without reading every chunk. **Prefer this over requesting more chunks when you need to verify whether something is used.**

**More chunks:** \`{"request_chunks":[{"uri":"src/foo.ts","reason":"…","preferred":{"near_line":250,"max_chunks":2}}]}\` or \`{"request_chunks":[{"uri":"src/foo.ts","reason":"…","preferred":{"line_range":{"start":45,"end":90},"max_chunks":2}}]}\`. Use \`line_range\` when you need exact lines. Keep \`max_chunks\` small (1–2); the context window is limited.

For questions about symbol usage (for example: "is this import unused?", references, call-sites), use \`search_file\` first and search the whole file with ripgrep. Do not use \`request_chunks\` to discover usages; only request chunks after search when exact surrounding code is still required.

**File listing:** \`{"request_files":[{"glob":"src/**/*","reason":"…"}]}\` → returns \`<file_list glob count>paths…</file_list>\`. Be specific with globs (e.g. **/*.cs, \`src/**/*.py\`); \`node_modules\`, \`.git\`, \`dist\`, \`build\` are excluded. Use correct extensions: \`cs\` for C#, \`cpp\` for C++, \`fs\` for F# (not \`c#\`, \`c++\`, \`f#\`).

## Editing files
Output anywhere in your response (optionally in a \`\`\`json fence):
\`\`\`json
{"edits":[{"uri":"src/file.ts","op":"replace_first","anchor":"exact text","text":"replacement"}]}
\`\`\`
Ops: \`replace_first\` · \`delete_first\` (omit text) · \`insert_after\` · \`insert_before\` · \`replace_all\` (omit anchor, replaces whole file).
URIs: workspace-relative, forward slashes, no leading slash. Anchor must match exactly — copy verbatim from the chunk. If you haven't read the file, use \`replace_all\`.

## Shell / file ops
\`\`\`
<RUN>command</RUN>                         result fed back as <RUN_RESULT>; use only when needed
<MOVE>
FROM: old/path
TO: new/path
</MOVE>   both paths must be inside workspace
<DELETE>
PATH: path/to/file
</DELETE>        moved to OS trash; only when user explicitly asks
\`\`\``;
}
