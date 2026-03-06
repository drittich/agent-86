import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Get the default shell for the current platform
 */
function getDefaultShell(): string {
  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    return shellEnv;
  }
  switch (process.platform) {
    case 'win32':
      return process.env.COMSPEC || 'cmd.exe';
    case 'darwin':
      return '/bin/zsh';
    default:
      return '/bin/bash';
  }
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
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Get workspace directory if available
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  return `Operating System: ${getOSName()}
OS Version: ${os.release()}
Platform: ${process.platform}
Default Shell: ${getDefaultShell()}
Home Directory: ${os.homedir()}
Current Working Directory: ${wsRoot}
Time Zone: ${timeZone}`;
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
 * Get the path to the system prompt file
 */
function getPromptPath(): string | undefined {
  // Check workspace root for prompts/system-prompt.md
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    const promptPath = path.join(wsRoot, 'prompts', 'system-prompt.md');
    if (fs.existsSync(promptPath)) {
      return promptPath;
    }
  }
  return undefined;
}

/**
 * Process the system prompt template by injecting dynamic system info
 */
export function getSystemPrompt(): string {
  // Try to load from prompts/system-prompt.md
  const promptPath = getPromptPath();
  
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
 * Get the native tools system prompt (used when toolUse is enabled)
 */
export function getNativeToolsPrompt(agentsMdSection: string, behaviorInstructions: string): string {
  return `You are a VS Code coding assistant.${agentsMdSection}

${behaviorInstructions}

## Files
Files arrive as \`<file_chunk path uri chunk_id lines total_chunks doc_version hash>\` blocks. You may only receive the first chunk initially. When \`<resolved_paths>\` is present, use those exact paths in tool calls.

## Tools
Use the provided tools to read files, make edits, run commands, and search. Prefer \`search_file_contents\` to verify usages before reading file sections. Use \`read_file\` with a line range when you need a specific section. Use \`string_replace\` for targeted edits.`;
}

/**
 * Get the legacy system prompt (used when toolUse is disabled)
 */
export function getLegacyPrompt(agentsMdSection: string, behaviorInstructions: string): string {
  return `You are a VS Code coding assistant.${agentsMdSection}

${behaviorInstructions}

## Files
Files arrive as \`<file_chunk path uri chunk_id lines total_chunks doc_version hash>\` blocks. You may only receive the first chunk initially. When \`<resolved_paths>\` is present, use those exact paths in \`search_file\` and \`request_chunks\` URIs.

## Requesting data
Before any file search, resolve workspace-relative paths and confirm existence.

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
