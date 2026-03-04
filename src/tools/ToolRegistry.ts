import { jsonSchema, tool, ToolSet } from 'ai';

/**
 * Native tool definitions for the Vercel AI SDK.
 *
 * These are passed directly to the LLM via the `tools` parameter on streamText().
 * When the active provider has `toolUse: false`, these are not sent and the system
 * falls back to the legacy XML/JSON schema injected in the system prompt.
 *
 * All tools have no `execute` function — execution is handled manually in
 * ToolExecutor so that destructive tools can show an approval gate first.
 */

export const AGENT_TOOLS: ToolSet = {
  // ── File operations ──────────────────────────────────────────────────────

  read_file: tool({
    description:
      'Read the contents of a file. Returns the file content, optionally limited to a line range. ' +
      'Use this to inspect source files before making edits.',
    inputSchema: jsonSchema<{
      path: string;
      start_line?: number;
      end_line?: number;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path (forward slashes, no leading slash).'
        },
        start_line: {
          type: 'number',
          description: '1-based start line (inclusive). Omit to read from the beginning.'
        },
        end_line: {
          type: 'number',
          description: '1-based end line (inclusive). Omit to read to the end of the file.'
        }
      },
      required: ['path']
    })
  }),

  write_file: tool({
    description:
      'Write (create or completely replace) a file with the given content. ' +
      'Use string_replace for targeted edits when possible; use write_file only when creating new files ' +
      'or when a full rewrite is cleaner.',
    inputSchema: jsonSchema<{
      path: string;
      content: string;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path (forward slashes, no leading slash).'
        },
        content: {
          type: 'string',
          description: 'The complete new content of the file.'
        }
      },
      required: ['path', 'content']
    })
  }),

  string_replace: tool({
    description:
      'Replace the first occurrence of an exact string in a file. ' +
      'The `old_str` must match the file content exactly (whitespace included). ' +
      'Prefer this over write_file for targeted edits.',
    inputSchema: jsonSchema<{
      path: string;
      old_str: string;
      new_str: string;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path (forward slashes, no leading slash).'
        },
        old_str: {
          type: 'string',
          description: 'The exact text to find and replace (must be unique in the file).'
        },
        new_str: {
          type: 'string',
          description: 'The replacement text.'
        }
      },
      required: ['path', 'old_str', 'new_str']
    })
  }),

  copy_file: tool({
    description: 'Copy a file to a new location within the workspace.',
    inputSchema: jsonSchema<{
      source: string;
      destination: string;
    }>({
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source path (workspace-relative).'
        },
        destination: {
          type: 'string',
          description: 'Destination path (workspace-relative).'
        }
      },
      required: ['source', 'destination']
    })
  }),

  move_file: tool({
    description: 'Move or rename a file within the workspace.',
    inputSchema: jsonSchema<{
      source: string;
      destination: string;
    }>({
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source path (workspace-relative).'
        },
        destination: {
          type: 'string',
          description: 'Destination path (workspace-relative).'
        }
      },
      required: ['source', 'destination']
    })
  }),

  delete_file: tool({
    description: 'Delete a file (moves it to the OS trash). Only use when the user explicitly asks to delete.',
    inputSchema: jsonSchema<{
      path: string;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path of the file to delete.'
        }
      },
      required: ['path']
    })
  }),

  create_directory: tool({
    description: 'Create a directory (and any missing parent directories) within the workspace.',
    inputSchema: jsonSchema<{
      path: string;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path of the directory to create.'
        }
      },
      required: ['path']
    })
  }),

  list_directory: tool({
    description:
      'List files matching a glob pattern within the workspace. ' +
      'Use specific globs (e.g. src/**/*.ts). Excludes node_modules, .git, dist, build.',
    inputSchema: jsonSchema<{
      glob: string;
    }>({
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description:
            'Glob pattern relative to workspace root. Use correct extensions: ' +
            'cs for C#, cpp for C++, fs for F# (not c#, c++, f#).'
        }
      },
      required: ['glob']
    })
  }),

  // ── Code execution ────────────────────────────────────────────────────────

  execute_bash: tool({
    description:
      'Execute a shell command in the workspace root. ' +
      'stdout + stderr are captured (capped at 32 KB). Times out after 30 s. ' +
      'Requires explicit user approval before running.',
    inputSchema: jsonSchema<{
      command: string;
    }>({
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.'
        }
      },
      required: ['command']
    })
  }),

  // ── Search ────────────────────────────────────────────────────────────────

  find_files: tool({
    description: 'Find files by glob pattern. Returns matching workspace-relative paths.',
    inputSchema: jsonSchema<{
      glob: string;
    }>({
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description: 'Glob pattern relative to workspace root.'
        }
      },
      required: ['glob']
    })
  }),

  search_file_contents: tool({
    description:
      'Search for a regex pattern within a file or directory using ripgrep. ' +
      'Returns matching lines with surrounding context. ' +
      'Use this to find usages, imports, and call sites rather than reading file chunks.',
    inputSchema: jsonSchema<{
      path: string;
      pattern: string;
      case_sensitive?: boolean;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace-relative path to a file or directory. ' +
            'For directories, searches recursively through source files.'
        },
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for.'
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether the search is case-sensitive. Defaults to true.'
        }
      },
      required: ['path', 'pattern']
    })
  }),

  // ── Interaction ───────────────────────────────────────────────────────────

  ask_question: tool({
    description:
      'Ask the user a clarifying question and wait for their answer before proceeding. ' +
      'Use when requirements are ambiguous or a decision requires user input.',
    inputSchema: jsonSchema<{
      question: string;
    }>({
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user.'
        }
      },
      required: ['question']
    })
  }),
};
