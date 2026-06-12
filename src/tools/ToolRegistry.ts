import { jsonSchema, tool, ToolSet } from 'ai';
import { execSync } from 'child_process';

/**
 * Native tool definitions for the Vercel AI SDK.
 *
 * These are passed directly to the LLM via the `tools` parameter on streamText().
 * When the active model is detected as not supporting native tool calling,
 * these are not sent and the system falls back to the legacy XML/JSON schema
 * injected in the system prompt.
 *
 * All tools have no `execute` function — execution is handled manually in
 * ToolExecutor so that destructive tools can show an approval gate first.
 */

// ── Git availability helpers ──────────────────────────────────────────────────

function isGitAvailable(): boolean {
  try { execSync('git --version', { stdio: 'ignore' }); return true; } catch { return false; }
}

function isInsideGitRepo(): boolean {
  try { execSync('git rev-parse --git-dir', { stdio: 'ignore' }); return true; } catch { return false; }
}

function isGhAvailable(): boolean {
  try { execSync('gh --version', { stdio: 'ignore' }); return true; } catch { return false; }
}

// ── Static tools (always available) ──────────────────────────────────────────

const STATIC_TOOLS: ToolSet = {
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
      'FALLBACK TOOL: prefer search_file_contents for targeted content search. ' +
      'Use list_directory only when: (a) the task explicitly asks for directory structure, ' +
      '(b) all targeted searches returned zero results, or (c) the repo is very small. ' +
      'Excludes node_modules, .git, dist, build, and gitignored paths.',
    inputSchema: jsonSchema<{
      glob: string;
    }>({
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description:
            'Glob pattern relative to workspace root. Use ** to search subdirectories. Use correct extensions: ' +
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
      'Use commands appropriate to the user\'s OS and shell as stated in the system prompt ' +
      '(on Windows/cmd.exe: type, dir, findstr — not cat, ls, grep). ' +
      'Do not use this for reading, listing, or searching files when native file tools (read_file, list_directory, search_file_contents) can answer the question.',
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
    description:
      'Find files by glob pattern. Returns matching workspace-relative paths. ' +
      'FALLBACK TOOL: prefer search_file_contents when looking for specific patterns. ' +
      'Use find_files only when: (a) you need directory structure, ' +
      '(b) targeted content search returned no results, or (c) the repo structure is genuinely unknown. ' +
      'Ignored folders and gitignored files are excluded.',
    inputSchema: jsonSchema<{
      glob: string;
    }>({
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description: 'Glob pattern relative to workspace root. Use ** to search subdirectories.'
        }
      },
      required: ['glob']
    })
  }),

  search_file_contents: tool({
    description:
      'PREFERRED FIRST TOOL for repository investigation. ' +
      'Search for a regex pattern within a file or directory using ripgrep. ' +
      'Returns matching lines with surrounding context. ' +
      'Use this as the first tool for most repository tasks — searching for relevant ' +
      'patterns (function names, imports, keywords) is more efficient than listing files first. ' +
      'If the exact file is unknown, search the workspace root "." or a subdirectory. ' +
      'WARNING: Results include line-number annotations (e.g. "> 92:") that are NOT in the actual file. ' +
      'Never use search result lines directly as old_str in string_replace — call read_file first.',
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

  // ── Diagnostics ───────────────────────────────────────────────────────────

  get_diagnostics: tool({
    description:
      'Get VS Code diagnostics (errors and warnings) for the workspace or a specific file. ' +
      'Returns problems grouped by file with severity, message, and line number.',
    inputSchema: jsonSchema<{
      path?: string;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional workspace-relative file path. Omit to get all workspace diagnostics.'
        }
      }
    })
  }),

  // ── Web ───────────────────────────────────────────────────────────────────

  web_search: tool({
    description:
      'IMPORTANT: Only use AFTER searching the codebase with search_file_contents and confirming the answer is not in the workspace. ' +
      'Do NOT use this as a first step for any question. ' +
      'Search the web using DuckDuckGo Lite. ' +
      'Rewrites the query into 2–3 targeted queries, searches in parallel, ranks and deduplicates results. ' +
      'Returns a ranked list of candidate URLs. Use fetch_url to read page content from the suggested fetches.',
    inputSchema: jsonSchema<{
      query: string;
      intent?: 'reference' | 'implementation' | 'debugging' | 'comparison' | 'general';
      max_results?: number;
    }>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Be specific — include library/framework names, API names, and exact error strings.'
        },
        intent: {
          type: 'string',
          enum: ['reference', 'implementation', 'debugging', 'comparison', 'general'],
          description:
            'Optional intent hint. ' +
            '"reference" for API/docs lookup, ' +
            '"implementation" for how-to/build questions, ' +
            '"debugging" for errors/failures, ' +
            '"comparison" for vs/choose questions. ' +
            'Auto-detected if omitted.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of candidates to return (1–20). Defaults to 8.'
        }
      },
      required: ['query']
    })
  }),

  fetch_url: tool({
    description:
      'Fetch the content of a URL and return it as plain text. ' +
      'Only use after searching the codebase first. ' +
      'Useful for reading documentation, GitHub files, or any public web page. ' +
      'Content is capped at 32 KB.',
    inputSchema: jsonSchema<{
      url: string;
    }>({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch.'
        }
      },
      required: ['url']
    })
  }),

  // ── Task management ───────────────────────────────────────────────────────

  create_task: tool({
    description:
      'Create one or more tasks to track work. Tasks are stored in .agent86/tasks.json in the workspace. ' +
      'Use this to break down complex requests into trackable steps.',
    inputSchema: jsonSchema<{
      tasks: Array<{ title: string; description?: string }>;
    }>({
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'List of tasks to create.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short task title.' },
              description: { type: 'string', description: 'Optional longer description.' }
            },
            required: ['title']
          }
        }
      },
      required: ['tasks']
    })
  }),

  list_tasks: tool({
    description: 'List all tasks grouped by status (pending, in_progress, completed).',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {}
    })
  }),

  update_task: tool({
    description: 'Update the status of a task.',
    inputSchema: jsonSchema<{
      id: string;
      status: 'pending' | 'in_progress' | 'completed';
    }>({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID (from list_tasks).' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New status for the task.'
        }
      },
      required: ['id', 'status']
    })
  }),

  delete_task: tool({
    description: 'Delete a task by ID.',
    inputSchema: jsonSchema<{
      id: string;
    }>({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID (from list_tasks).' }
      },
      required: ['id']
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

// ── Git tools (conditionally included) ───────────────────────────────────────

const GIT_TOOLS: ToolSet = {
  git_status: tool({
    description: 'Show the working tree status (modified, staged, untracked files).',
    inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} })
  }),

  git_diff: tool({
    description: 'Show changes between commits, the working tree, or staged changes.',
    inputSchema: jsonSchema<{
      args?: string;
    }>({
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Optional git diff arguments, e.g. "--staged", "HEAD~1", "src/file.ts". Omit for unstaged changes.'
        }
      }
    })
  }),

  git_log: tool({
    description: 'Show the commit history.',
    inputSchema: jsonSchema<{
      max_count?: number;
      args?: string;
    }>({
      type: 'object',
      properties: {
        max_count: { type: 'number', description: 'Number of commits to show. Defaults to 10.' },
        args: { type: 'string', description: 'Additional git log arguments, e.g. "--oneline", "-- src/file.ts".' }
      }
    })
  }),

  git_add: tool({
    description: 'Stage files for the next commit. Requires user approval.',
    inputSchema: jsonSchema<{
      paths: string[];
    }>({
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace-relative paths to stage. Use ["."] to stage all changes.'
        }
      },
      required: ['paths']
    })
  }),

  git_commit: tool({
    description: 'Create a commit with the staged changes. Always requires user approval.',
    inputSchema: jsonSchema<{
      message: string;
      body?: string;
    }>({
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message subject line.' },
        body: { type: 'string', description: 'Optional commit body (additional detail).' }
      },
      required: ['message']
    })
  }),

  git_push: tool({
    description: 'Push commits to the remote. Requires user approval.',
    inputSchema: jsonSchema<{
      args?: string;
    }>({
      type: 'object',
      properties: {
        args: { type: 'string', description: 'Optional push arguments, e.g. "--force-with-lease", "origin main".' }
      }
    })
  }),

  git_pull: tool({
    description: 'Pull changes from the remote. Requires user approval.',
    inputSchema: jsonSchema<{
      args?: string;
    }>({
      type: 'object',
      properties: {
        args: { type: 'string', description: 'Optional pull arguments, e.g. "--rebase".' }
      }
    })
  }),

  git_branch: tool({
    description: 'List, create, or delete branches.',
    inputSchema: jsonSchema<{
      args?: string;
    }>({
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Branch arguments: omit to list branches, provide a name to create, "-d name" to delete.'
        }
      }
    })
  }),

  git_stash: tool({
    description: 'Stash or restore changes. Requires user approval for push/pop/drop.',
    inputSchema: jsonSchema<{
      args?: string;
    }>({
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Stash arguments: "push" (default), "pop", "list", "drop".'
        }
      }
    })
  }),

  git_reset: tool({
    description: 'Reset the current HEAD or unstage files. Hard resets require user approval.',
    inputSchema: jsonSchema<{
      args: string;
    }>({
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Reset arguments, e.g. "HEAD~1", "--soft HEAD~1", "--hard HEAD~1", "src/file.ts".'
        }
      },
      required: ['args']
    })
  }),
};

const GIT_PR_TOOL: ToolSet = {
  git_pr: tool({
    description: 'Create or list pull requests using the GitHub CLI (gh). Requires user approval.',
    inputSchema: jsonSchema<{
      args: string;
    }>({
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'gh pr arguments, e.g. "create --title \\"Fix bug\\" --body \\"...\\"", "list".'
        }
      },
      required: ['args']
    })
  }),
};

/**
 * Build the complete tool set for the current environment.
 * Git tools are included only if git is installed and the workspace is a git repo.
 * gh pr tool is included only if the gh CLI is available.
 */
export function buildAgentTools(): ToolSet {
  const tools: ToolSet = { ...STATIC_TOOLS };

  if (isGitAvailable() && isInsideGitRepo()) {
    Object.assign(tools, GIT_TOOLS);
    if (isGhAvailable()) {
      Object.assign(tools, GIT_PR_TOOL);
    }
  }

  return tools;
}

/** @deprecated Use buildAgentTools() instead. */
export const AGENT_TOOLS: ToolSet = STATIC_TOOLS;
