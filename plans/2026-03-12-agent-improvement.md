# VS Code Agent Improvement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve repository-task performance for small local models by enforcing search-first tool selection, model-tier execution modes, and stronger task classification with heuristic routing.

**Architecture:** Add a `TaskClassifier` module that classifies incoming requests and selects a `ModelProfile` from config. Use the profile to drive tool selection policy in `ChatPanel`, update tool descriptions to bias `search_file_contents` as the preferred first tool, and strengthen recovery prompts. A new `ModelProfile` type in `ConfigManager` carries per-tier constraints that the streaming loop reads at turn start.

**Tech Stack:** TypeScript, VS Code Extension API, Vercel AI SDK v6, existing `ToolRegistry` / `ToolExecutor` / `ChatPanel` pattern.

---

## Existing implementations — do NOT re-implement

The following spec items are already implemented in the codebase:

- **Empty response recovery** (3-level: silent retry → concrete-read nudge → compact final-answer prompt) — `ChatPanel._handleSend` lines 935–993
- **Context compaction of tool outputs** — `ChatPanel._compactToolResultForHistory`
- **Post-discovery refocus prompts** — `_buildDiscoveryRefocusPrompt`, `_buildConcreteReadRefocusPrompt`
- **`read_file` with line range** — `ToolRegistry` `start_line`/`end_line` params, `ToolExecutor`
- **Discovery loop detection** — `seenDiscoveryGlobs`, `repetitiveDiscoveryRounds`, `discoveryLoopWithoutEvidence`

This plan implements the remaining spec gaps:

1. Task classification + heuristic routing
2. Model-tier execution modes (small / balanced / high-capability)
3. Search-first tool description policy (update tool descriptions + system prompt)
4. Logging/observability for first-tool quality and stall events

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `src/agent/TaskClassifier.ts` | **Create** | Classify task type + extract domain hints from prompt |
| `src/agent/ModelProfile.ts` | **Create** | Types + presets for small/balanced/high-capability modes |
| `src/config/ConfigManager.ts` | **Modify** | Add `modelTier` setting; expose `getModelProfile()` |
| `src/tools/ToolRegistry.ts` | **Modify** | Update `list_directory`/`find_files` descriptions to reflect fallback-only status; promote `search_file_contents` |
| `src/utils/PromptProcessor.ts` | **Modify** | Update `getNativeToolsPrompt` to emphasise search-first and non-empty post-tool behaviour |
| `src/chat/ChatPanel.ts` | **Modify** | Use `TaskClassifier` result + `ModelProfile` to: (a) inject domain-aware search hint at turn start; (b) tune loop limits by profile; (c) log first-tool + stall metrics |

---

## Chunk 1: Core types — TaskClassifier and ModelProfile

### Task 1: Create `ModelProfile` types and presets

**Files:**
- Create: `src/agent/ModelProfile.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/agent/ModelProfile.ts

export type ModelTier = 'small' | 'balanced' | 'high';

export interface ModelProfile {
  tier: ModelTier;
  /** Max discovery steps before a file-read is required */
  maxDiscoveryStepsBeforeRead: number;
  /** Max file reads before evidence summary is injected */
  maxFileReadsBeforeSummary: number;
  /** Whether broad list_directory/**/*.ext is allowed as first call */
  allowBroadListingFirst: boolean;
  /** Empty response count before recovery triggers */
  emptyResponseRecoveryThreshold: number;
  /** 'aggressive' | 'moderate' | 'light' */
  historyCompactionLevel: 'aggressive' | 'moderate' | 'light';
}

export const MODEL_PROFILES: Record<ModelTier, ModelProfile> = {
  small: {
    tier: 'small',
    maxDiscoveryStepsBeforeRead: 1,
    maxFileReadsBeforeSummary: 2,
    allowBroadListingFirst: false,
    emptyResponseRecoveryThreshold: 1,
    historyCompactionLevel: 'aggressive',
  },
  balanced: {
    tier: 'balanced',
    maxDiscoveryStepsBeforeRead: 2,
    maxFileReadsBeforeSummary: 3,
    allowBroadListingFirst: false,
    emptyResponseRecoveryThreshold: 2,
    historyCompactionLevel: 'moderate',
  },
  high: {
    tier: 'high',
    maxDiscoveryStepsBeforeRead: 3,
    maxFileReadsBeforeSummary: 4,
    allowBroadListingFirst: false,
    emptyResponseRecoveryThreshold: 2,
    historyCompactionLevel: 'light',
  },
};

export function getModelProfile(tier: ModelTier): ModelProfile {
  return MODEL_PROFILES[tier];
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1 | head -30
```

Expected: no errors (new file, no imports yet)

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add src/agent/ModelProfile.ts
git commit -m "feat: add ModelProfile types and tier presets (small/balanced/high)"
```

---

### Task 2: Create `TaskClassifier`

**Files:**
- Create: `src/agent/TaskClassifier.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/agent/TaskClassifier.ts

export type TaskType =
  | 'bug_fix'
  | 'feature_implementation'
  | 'performance_optimization'
  | 'refactor'
  | 'explanation';

export interface TaskClassification {
  taskType: TaskType;
  /** Domain hint keywords found in the prompt (e.g. 'startup', 'cache') */
  domainHints: string[];
  /** Whether startup/load/bootstrap patterns are prominent */
  isStartupTask: boolean;
  /** Whether import/module/cache patterns are prominent */
  isModuleLoadTask: boolean;
}

/** Keywords that signal performance/startup tasks */
const STARTUP_HINTS = [
  'startup', 'bootstrap', 'initialize', 'initialise', 'importlib', 'import_module',
  'pkgutil', 'iter_modules', '__import__', 'os.walk', 'cache', 'version',
  'discover', 'plugin', 'load_modules', 'scan_modules', 'load', 'scan',
];

/** Keywords that signal bug-fix tasks */
const BUG_HINTS = ['bug', 'error', 'fix', 'broken', 'crash', 'exception', 'fail', 'wrong', 'incorrect', 'traceback'];

/** Keywords that signal feature work */
const FEATURE_HINTS = ['add', 'implement', 'create', 'build', 'feature', 'support', 'new'];

/** Keywords that signal refactoring */
const REFACTOR_HINTS = ['refactor', 'rename', 'move', 'reorganize', 'reorganise', 'restructure', 'clean up', 'extract'];

/** Keywords that signal performance optimization */
const PERF_HINTS = ['speed', 'slow', 'performance', 'optimize', 'optimise', 'fast', 'latency', 'memory', 'profil'];

export function classifyTask(prompt: string): TaskClassification {
  const lower = prompt.toLowerCase();

  // Collect startup domain hints present in the prompt
  const domainHints = STARTUP_HINTS.filter(h => lower.includes(h));
  const isStartupTask = domainHints.some(h =>
    ['startup', 'bootstrap', 'initialize', 'initialise', 'load', 'scan', 'discover'].includes(h)
  );
  const isModuleLoadTask = domainHints.some(h =>
    ['importlib', 'import_module', 'pkgutil', 'iter_modules', '__import__', 'load_modules', 'scan_modules', 'plugin'].includes(h)
  );

  // Task type: first match wins
  let taskType: TaskType = 'explanation';
  if (PERF_HINTS.some(h => lower.includes(h)) || (isStartupTask && lower.includes('speed'))) {
    taskType = 'performance_optimization';
  } else if (BUG_HINTS.some(h => lower.includes(h))) {
    taskType = 'bug_fix';
  } else if (REFACTOR_HINTS.some(h => lower.includes(h))) {
    taskType = 'refactor';
  } else if (FEATURE_HINTS.some(h => lower.includes(h))) {
    taskType = 'feature_implementation';
  }

  // Startup/performance tasks that mention 'startup' override to perf even without 'slow'
  if (isStartupTask && taskType === 'explanation') {
    taskType = 'performance_optimization';
  }

  return { taskType, domainHints, isStartupTask, isModuleLoadTask };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add src/agent/TaskClassifier.ts
git commit -m "feat: add TaskClassifier for task type and domain hint detection"
```

---

## Chunk 2: ConfigManager — model tier setting

### Task 3: Add `modelTier` configuration setting

**Files:**
- Modify: `package.json` (add VS Code setting)
- Modify: `src/config/ConfigManager.ts` (expose getter)

- [ ] **Step 1: Read ConfigManager**

Read `src/config/ConfigManager.ts` to understand the existing pattern before modifying.

- [ ] **Step 2: Add `modelTier` to package.json configuration**

In `package.json`, within the `contributes.configuration.properties` object, add:

```json
"agent86.modelTier": {
  "type": "string",
  "enum": ["small", "balanced", "high"],
  "default": "balanced",
  "description": "Model tier for tool selection policy. 'small' enforces strict search-first with aggressive recovery. 'balanced' is the default for 35B-class models. 'high' allows broader exploration for capable hosted models."
}
```

- [ ] **Step 3: Add `getModelTier()` to ConfigManager**

In `src/config/ConfigManager.ts`, add a method that reads the setting:

```typescript
import { ModelTier } from '../agent/ModelProfile';

// Inside the ConfigManager class:
public getModelTier(): ModelTier {
  const tier = vscode.workspace.getConfiguration('agent86').get<string>('modelTier') ?? 'balanced';
  if (tier === 'small' || tier === 'balanced' || tier === 'high') {
    return tier;
  }
  return 'balanced';
}
```

- [ ] **Step 4: Typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add package.json src/config/ConfigManager.ts
git commit -m "feat: add modelTier config setting and ConfigManager.getModelTier()"
```

---

## Chunk 3: Tool description updates — search-first bias

### Task 4: Update tool descriptions in ToolRegistry

The current tool descriptions still suggest `find_files`/`list_directory` for initial discovery. The spec requires search-first policy. Update tool descriptions to reflect this.

**Files:**
- Modify: `src/tools/ToolRegistry.ts`

- [ ] **Step 1: Read the current descriptions**

Read lines 189–252 of `src/tools/ToolRegistry.ts` (list_directory and find_files descriptions).

- [ ] **Step 2: Update `list_directory` description**

Change the description from the current text to:

```typescript
description:
  'List files matching a glob pattern within the workspace. ' +
  'FALLBACK TOOL: prefer search_file_contents for targeted content search. ' +
  'Use list_directory only when: (a) the task explicitly asks for directory structure, ' +
  '(b) all targeted searches returned zero results, or (c) the repo is very small. ' +
  'Excludes node_modules, .git, dist, build, and gitignored paths.',
```

- [ ] **Step 3: Update `find_files` description**

Change the description from the current text to:

```typescript
description:
  'Find files by glob pattern. Returns matching workspace-relative paths. ' +
  'FALLBACK TOOL: prefer search_file_contents when looking for specific patterns. ' +
  'Use find_files only when: (a) you need directory structure, ' +
  '(b) targeted content search returned no results, or (c) the repo structure is genuinely unknown. ' +
  'Ignored folders and gitignored files are excluded.',
```

- [ ] **Step 4: Update `search_file_contents` description to clarify it as the preferred first tool**

Prepend to the existing description:

```typescript
description:
  'PREFERRED FIRST TOOL for repository investigation. ' +
  'Search for a regex pattern within a file or directory using ripgrep. ' +
  'Returns matching lines with surrounding context. ' +
  'Use this as the first tool for most repository tasks — searching for relevant ' +
  'patterns (function names, imports, keywords) is more efficient than listing files first. ' +
  'If the exact file is unknown, search the workspace root "." or a subdirectory. ' +
  'WARNING: Results include line-number annotations (e.g. "> 92:") that are NOT in the actual file. ' +
  'Never use search result lines directly as old_str in string_replace — call read_file first.',
```

- [ ] **Step 5: Typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add src/tools/ToolRegistry.ts
git commit -m "feat: update tool descriptions — search_file_contents as preferred first tool, list_directory/find_files as fallback-only"
```

---

## Chunk 4: System prompt update — search-first policy

### Task 5: Update `getNativeToolsPrompt` in PromptProcessor

**Files:**
- Modify: `src/utils/PromptProcessor.ts`

- [ ] **Step 1: Read the current getNativeToolsPrompt function** (lines 112–135 of `src/utils/PromptProcessor.ts`)

- [ ] **Step 2: Replace the Discovery section**

Replace the current `## Discovery` section in `getNativeToolsPrompt` with:

```typescript
## Investigation strategy
For broad repository requests (performance, bugs, architecture, feature planning):
- Start with search_file_contents using relevant keywords — do NOT start with list_directory or find_files.
- After search results, read one high-confidence file immediately.
- After each tool result, either call one concrete next tool OR answer directly.
- Never return an empty response after tool results.

## Discovery (fallback only)
Use find_files or list_directory only when:
- All targeted searches returned zero results.
- The task explicitly asks for directory structure.
- The repository structure is genuinely unknown and no keyword search is possible.
Prefer app-owned paths (e.g. src/, app/, web/) over broad workspace-wide globs.

## When to stop calling tools
After reading 2-3 relevant files, synthesize findings and answer directly.
Do not keep calling tools once sufficient evidence exists.
```

- [ ] **Step 3: Typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add src/utils/PromptProcessor.ts
git commit -m "feat: update system prompt to enforce search-first investigation strategy"
```

---

## Chunk 5: ChatPanel — task classification, profile-aware loop limits, and observability

### Task 6: Wire TaskClassifier and ModelProfile into ChatPanel._handleSend

This is the main integration. Read `src/chat/ChatPanel.ts` lines 669–870 carefully before editing.

**Files:**
- Modify: `src/chat/ChatPanel.ts`

- [ ] **Step 1: Read the relevant section**

Read lines 669–870 of `src/chat/ChatPanel.ts` (the `_handleSend` method start through variable initialization).

- [ ] **Step 2: Add imports**

At the top of `ChatPanel.ts`, add:

```typescript
import { classifyTask, TaskClassification } from '../agent/TaskClassifier';
import { getModelProfile, ModelProfile } from '../agent/ModelProfile';
```

- [ ] **Step 3: Classify the task at the start of `_handleSend`**

After the line `this._userCancelled = false;` (around line 674), add:

```typescript
// Classify task and load model profile for this turn
const taskClassification = classifyTask(prompt);
const modelTier = this._configManager.getModelTier();
const modelProfile = getModelProfile(modelTier);
this._log.appendLine(
  `[classify] taskType=${taskClassification.taskType}, tier=${modelTier}, ` +
  `domainHints=[${taskClassification.domainHints.join(', ')}], ` +
  `isStartupTask=${taskClassification.isStartupTask}`
);
```

- [ ] **Step 4: Use profile to tune MAX_EXPLORATION_TOOL_ROUNDS**

Find the line (around 836):
```typescript
const MAX_EXPLORATION_TOOL_ROUNDS = 6;
```

Replace with:
```typescript
// Profile drives exploration depth — small models get tighter limits
const MAX_EXPLORATION_TOOL_ROUNDS = modelProfile.maxDiscoveryStepsBeforeRead + modelProfile.maxFileReadsBeforeSummary + 1;
```

- [ ] **Step 5: Use profile for broad-listing policy**

Find the check for `discoveryLoopWithoutEvidence` (around line 1078). After it is defined, add a profile-driven check:

```typescript
// Small-model profile: block broad listing as first action regardless of other conditions
const profileBlocksBroadListing = !modelProfile.allowBroadListingFirst && substantiveToolRounds === 0 && toolRound === 0 && discoveryCalls.length > 0;
```

Then include `profileBlocksBroadListing` in the condition that triggers `_buildDiscoveryRefocusPrompt`:

Change the condition from:
```typescript
if (!forcePlainTextAnswer && discoveryLoopWithoutEvidence && discoveryRefocuses < MAX_DISCOVERY_REFOCUS) {
```
to:
```typescript
if (!forcePlainTextAnswer && (discoveryLoopWithoutEvidence || profileBlocksBroadListing) && discoveryRefocuses < MAX_DISCOVERY_REFOCUS) {
```

- [ ] **Step 6: Inject domain-aware search hint using TaskClassification**

The existing `_buildDiscoveryHint` method builds a hint from the prompt. For startup tasks, inject an additional search-focused hint. Find where `discoveryHint` is built and injected (around lines 772–775):

```typescript
const discoveryHint = this._buildDiscoveryHint(prompt);
if (discoveryHint) {
  userContent = `${userContent}\n\n${discoveryHint}`;
}
```

Replace with:

```typescript
const discoveryHint = this._buildDiscoveryHint(prompt);
const classifierHint = this._buildClassifierHint(taskClassification);
if (discoveryHint) {
  userContent = `${userContent}\n\n${discoveryHint}`;
}
if (classifierHint) {
  userContent = `${userContent}\n\n${classifierHint}`;
}
```

- [ ] **Step 7: Add `_buildClassifierHint` method**

Add this private method to `ChatPanel` (near `_buildDiscoveryHint`):

```typescript
private _buildClassifierHint(classification: TaskClassification): string | undefined {
  if (classification.domainHints.length === 0) {
    return undefined;
  }

  const lines = [
    '<task_hint>',
    `Task type: ${classification.taskType.replace(/_/g, ' ')}.`,
  ];

  if (classification.isStartupTask || classification.isModuleLoadTask) {
    lines.push('For startup/module-loading tasks, search for these patterns first:');
    const terms = classification.domainHints.slice(0, 6);
    lines.push(...terms.map(t => `- ${t}`));
    lines.push('Prefer app-owned paths: src/, app/, web/, plugins/, utils/');
    lines.push('Do NOT start with list_directory. Use search_file_contents with these terms first.');
  }

  lines.push('</task_hint>');
  return lines.join('\n');
}
```

- [ ] **Step 8: Add first-tool observability logging**

After the tool round's assistant message is recorded (around line 1144, where `pendingToolCalls` are iterated), add logging for the first tool:

```typescript
// Log first-tool quality for observability
if (toolRound === 1 && pendingToolCalls.length > 0) {
  const firstTool = pendingToolCalls[0];
  const isTargeted = firstTool.toolName === 'search_file_contents';
  const isBroad = firstTool.toolName === 'find_files' || firstTool.toolName === 'list_directory';
  this._log.appendLine(
    `[metrics] first_tool=${firstTool.toolName}, targeted=${isTargeted}, broad=${isBroad}, ` +
    `taskType=${taskClassification.taskType}, tier=${modelTier}`
  );
}
```

- [ ] **Step 9: Log stall events**

Find the silent retry block (around line 939). After the log line inside the `if (silentRetries < MAX_SILENT_RETRIES)` block, add:

```typescript
this._log.appendLine(
  `[metrics] stall_event, toolRound=${toolRound}, taskType=${taskClassification.taskType}, tier=${modelTier}`
);
```

- [ ] **Step 10: Typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1 | head -50
```

Expected: no errors. Fix any type errors before committing.

- [ ] **Step 11: Build**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run build 2>&1 | tail -20
```

Expected: no build errors.

- [ ] **Step 12: Commit**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add src/chat/ChatPanel.ts
git commit -m "feat: integrate TaskClassifier and ModelProfile into ChatPanel — profile-aware limits, classifier hint injection, first-tool and stall metrics"
```

---

## Chunk 6: End-to-end verification and cleanup

### Task 7: Verify the build and run a typecheck

- [ ] **Step 1: Full typecheck**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 2: Full build**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86" && npm run build 2>&1 | tail -20
```

Expected: bundled successfully, no errors.

- [ ] **Step 3: Verify new files exist**

```bash
ls "c:/Users/darcy/source/repos/_Utilities/agent-86/src/agent/"
```

Expected: `AgentRunner.ts  ModelProfile.ts  TaskClassifier.ts`

- [ ] **Step 4: Spot-check log output format**

Open the Output panel in VS Code and trigger a startup-related prompt. The log should now include lines like:
```
[classify] taskType=performance_optimization, tier=balanced, domainHints=[startup, cache], isStartupTask=true
[metrics] first_tool=search_file_contents, targeted=true, broad=false, taskType=performance_optimization, tier=balanced
```

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
cd "c:/Users/darcy/source/repos/_Utilities/agent-86"
git add -p   # stage only intentional cleanup
git commit -m "chore: cleanup after agent improvement implementation"
```

---

## Acceptance criteria mapping

| AC | Spec criterion | How this plan addresses it |
|----|----------------|---------------------------|
| AC-1 | ≥80% sessions start with targeted search | Tool descriptions + system prompt bias `search_file_contents` first; classifier hint reinforces for startup tasks |
| AC-2 | Empty post-tool turns reduced ≥90% | Already implemented (silent retry → nudge → final answer); `emptyResponseRecoveryThreshold` from profile now drives timing |
| AC-3 | 9B models read startup file in first 2 calls ≥75% | `small` tier profile blocks broad listing; classifier hint injects search terms; discovery refocus fires earlier |
| AC-4 | Prompt token growth reduced | Already implemented via `_compactToolResultForHistory`; unchanged |
| AC-5 | 35B/stronger models can explore multiple files | `balanced`/`high` profiles allow more exploration steps; `allowBroadListingFirst: false` still applies but less strict limits |

---

## Out of scope for this plan

- `search_symbols` tool (optional per spec §9.2.4) — add separately when needed
- `get_related_files` tool (optional per spec §9.2.5) — add separately
- Benchmark harness (spec Phase 4) — separate project
- UI for model tier selection (setting is workspace config, accessible via VS Code settings)
