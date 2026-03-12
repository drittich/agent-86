# VS Code Agent Improvement Spec

## Document status

- **Owner:** D’Arcy Rittich
- **Target:** VS Code extension agent orchestration
- **Primary models:** `gpt3.5-9B-Q6K`, `gpt3.5-35B-A3B-Q4_K_M`
- **Secondary models:** stronger hosted/local models
- **Status:** Draft engineering spec

---

## 1. Purpose

Improve repository-task performance for the coding agent, especially on smaller local models, by:

- improving first-tool selection
- reducing empty/stalled turns after tool calls
- making tool outputs more actionable
- constraining exploration for weaker models
- preserving flexibility for stronger models

This spec focuses on **repository analysis and coding tasks**, especially broad requests like:

- performance optimization
- startup investigation
- bug source identification
- architecture discovery
- targeted feature implementation

---

## 2. Problem statement

Current behavior shows several failure patterns:

1. The agent often starts with broad discovery, such as listing all Python files.
2. Tool results are high-volume but low-signal.
3. Smaller models frequently produce an empty response after tool results.
4. Recovery happens too late and is too weakly structured.
5. Prompt history grows with low-value data, degrading quality and latency.

### Example failure mode

For a request about startup performance and Python module loading, the agent:

- called `list_directory("**/*.py")`
- got 254 files
- returned empty output multiple times
- only progressed after forced controller intervention
- still produced a weak final answer

This indicates an orchestration issue more than a raw inference-speed issue.

---

## 3. Goals

### 3.1 Primary goals

- increase relevance of the first tool call
- reduce empty responses after tool results to near zero
- improve selection of files for inspection
- reduce token waste from broad discovery
- improve final diagnosis and patch proposals on 9B-class models

### 3.2 Secondary goals

- support 35B-class local models with less overconstraint
- support stronger models without blocking richer reasoning
- make orchestration behavior measurable and tunable

### 3.3 Non-goals

- replacing the model
- solving code editing quality in this spec
- solving all multi-file patch planning
- introducing autonomous background workflows

---

## 4. Scope

This spec applies to:

- repository investigation tasks
- code search and navigation
- startup/performance diagnosis
- targeted implementation planning
- controller logic around tool selection and recovery

This spec does **not** define:

- UI design details
- transport protocol details
- model serving backend architecture
- editor diff UX

---

## 5. High-level design

The agent should move from an **open-ended assistant** model to a **guided investigator** model.

### Current pattern

1. receive broad request
2. choose broad discovery tool
3. dump large result into context
4. hope model chooses next step
5. retry if it stalls

### New pattern

1. classify task
2. choose targeted discovery tool
3. return ranked candidates
4. read one likely file
5. summarize evidence
6. read next file only if needed
7. propose change or patch target
8. edit once confidence is sufficient

---

## 6. Functional requirements

### FR-1: Task classification

The controller must classify incoming repository tasks into one of:

- bug fix
- feature implementation
- performance optimization
- refactor
- explanation / architecture discovery

The classification may be heuristic and does not need a separate model call.

### FR-2: Heuristic routing

The controller must detect domain hints in the user request and bias tool selection accordingly.

Example startup/performance hints:

- startup
- initialize
- load
- import
- scan
- modules
- plugin
- cache
- version
- bootstrap
- discover

### FR-3: Search-first policy

For broad repository tasks, the agent must prefer targeted search over directory listing.

The first tool call should usually be one of:

- `search_code`
- `grep_repo`
- `search_symbols`

The first tool call should **not** be `list_directory` unless no search tool is available or the task explicitly asks for structure.

### FR-4: Forced post-discovery read

After a discovery/search tool returns candidate files, the next agent action must be one of:

- `read_file`
- `read_file_range`
- answer directly if evidence is already sufficient

The controller must not allow repeated broad discovery loops without a file read.

### FR-5: Non-empty post-tool behavior

After a tool result, the agent must produce one of:

- exactly one next tool call
- a direct answer
- a structured clarification only if absolutely required

The agent must never produce an empty message.

### FR-6: Evidence summaries

After 1–3 file reads, the controller should inject or preserve a compact evidence summary describing:

- what was found
- what remains unknown
- best next target
- confidence level

### FR-7: Context compaction

Raw discovery tool output should not be replayed in full across turns when a compact structured summary can replace it.

### FR-8: Model-aware policy

The controller must support at least three execution modes:

- small-model safe mode
- balanced local mode
- high-capability mode

---

## 7. Non-functional requirements

### NFR-1: Reliability

- Empty post-tool turns should be reduced to less than 1% of repository-task tool transitions.

### NFR-2: Efficiency

- Tool outputs should minimize unnecessary token load.
- Large directory dumps should be avoided.

### NFR-3: Adaptability

- The same architecture should work across 9B, 35B, and stronger models.

### NFR-4: Observability

The system must log enough metadata to evaluate:

- first-tool quality
- stall events
- tool sequencing
- token growth
- task completion rate

---

## 8. Architecture changes

## 8.1 Controller pipeline

Proposed pipeline:

1. **Task Intake**
2. **Task Classification**
3. **Heuristic Selection**
4. **Tool Policy Selection**
5. **Tool Execution**
6. **Post-Tool Validation**
7. **Context Compaction**
8. **Retry / Recovery**
9. **Answer / Edit Phase**

---

## 8.2 Repository-task state machine

```text
IDLE
  -> CLASSIFY_TASK
  -> SELECT_STRATEGY
  -> DISCOVERY
  -> READ_TARGET
  -> EVIDENCE_SUMMARY
  -> DECIDE_NEXT
      -> READ_TARGET
      -> PROPOSE_PATCH
      -> ANSWER
  -> EDIT
  -> COMPLETE
```

### State descriptions

#### `CLASSIFY_TASK`

Determine whether request is performance, bug, feature, refactor, or explanation.

#### `SELECT_STRATEGY`

Apply request-specific heuristics and model-tier constraints.

#### `DISCOVERY`

Run one targeted search tool to find candidate files/snippets.

#### `READ_TARGET`

Read one high-confidence file or file range.

#### `EVIDENCE_SUMMARY`

Create a compact controller summary.

#### `DECIDE_NEXT`

Choose among:

- read another file
- propose patch
- answer
- edit

#### `EDIT`

Only enter once file targets and change strategy are concrete.

---

## 9. Tooling spec

## 9.1 Existing tools

### `read_file(path)`

Reads full file content.

Use when:

- file is short
- full context is important

### `edit_file(path, changes)`

Applies code changes.

Use when:

- change target is concrete
- sufficient evidence exists

### `list_directory(glob)`

Fallback-only discovery tool.

Use when:

- no search tool exists
- task explicitly asks for structure
- repo is small
- targeted search failed

---

## 9.2 New or upgraded tools

## 9.2.1 `search_code`

### Purpose

Repository-aware search for likely relevant files/snippets using patterns and ranking hints.

### Inputs

```json
{
  "queries": ["startup", "bootstrap", "importlib", "cache", "version"],
  "limit": 10,
  "pathHints": ["app", "setup", "plugins"],
  "preferEntrypoints": true
}
```

### Output

```json
{
  "candidates": [
    {
      "path": "plugins/loader.py",
      "score": 0.93,
      "reason": "Contains module discovery logic",
      "snippets": [
        {
          "line": 42,
          "text": "for m in pkgutil.iter_modules(...)"
        }
      ]
    }
  ],
  "recommendedNextRead": "plugins/loader.py"
}
```

### Requirements

- rank results by relevance
- return short snippets
- return a recommended next read
- prioritize startup/bootstrap/entrypoint files when relevant

---

## 9.2.2 `grep_repo`

### Purpose

Exact or regex-like search for literal patterns.

### Inputs

```json
{
  "patterns": [
    "importlib.import_module",
    "pkgutil.iter_modules",
    "__import__(",
    "os.walk(",
    "glob("
  ],
  "limit": 20
}
```

### Output

```json
{
  "matches": [
    {
      "path": "app/startup.py",
      "line": 18,
      "text": "importlib.import_module(name)"
    }
  ]
}
```

### Requirements

- optimized for precise API lookups
- low token overhead
- line/snippet output only

---

## 9.2.3 `read_file_range`

### Purpose

Read only the most relevant section of a file.

### Inputs

```json
{
  "path": "plugins/loader.py",
  "startLine": 30,
  "endLine": 110
}
```

### Output

```json
{
  "path": "plugins/loader.py",
  "startLine": 30,
  "endLine": 110,
  "content": "..."
}
```

### Requirements

- lower token load than full-file reads
- preferred for large files after search hit localization

---

## 9.2.4 `search_symbols` (recommended)

### Purpose

Locate function/class definitions and references.

### Inputs

```json
{
  "queries": ["startup", "initialize", "load_plugins", "get_version"]
}
```

### Output

```json
{
  "symbols": [
    {
      "name": "load_plugins",
      "kind": "function",
      "path": "plugins/loader.py",
      "line": 12
    }
  ]
}
```

### Requirements

- return definitions first
- optionally include references/callers
- useful for weak models because it raises abstraction

---

## 9.2.5 `get_related_files` (optional but high value)

### Purpose

Given a current file, suggest adjacent files by import graph, naming, or repository conventions.

### Inputs

```json
{
  "path": "plugins/loader.py",
  "limit": 5
}
```

### Output

```json
{
  "related": [
    {
      "path": "app/version.py",
      "reason": "Imported in loader"
    },
    {
      "path": "utils/cache.py",
      "reason": "Likely cache helper by naming similarity"
    }
  ]
}
```

---

## 10. Tool selection policy

## 10.1 Default policy for repository tasks

Preferred order:

1. `search_code`
2. `grep_repo`
3. `search_symbols`
4. `read_file_range`
5. `read_file`
6. `edit_file`

Fallback: 7. `list_directory`

## 10.2 Disallowed first actions for broad optimization tasks

Do not use as first action:

- `list_directory("**/*.py")`
- multiple broad discovery tools in a row

## 10.3 Allowed exceptions

Broad listing is allowed first if:

- the user asks for directory structure
- the repo is known to be tiny
- search tools are unavailable
- targeted search returned zero meaningful hits

---

## 11. Model-tier execution modes

## 11.1 Small-model safe mode

### Target models

- `gpt3.5-9B-Q6K`

### Constraints

- search-first required
- no broad listing first
- max 1 discovery step before mandatory file read
- max 2 file reads before required evidence summary
- recovery after first empty output
- aggressive prompt compaction
- prefer one concrete action per turn

### Recommended settings

```json
{
  "maxDiscoveryStepsBeforeRead": 1,
  "maxFileReadsBeforeSummary": 2,
  "allowBroadListingFirst": false,
  "emptyResponseRecoveryThreshold": 1,
  "historyCompactionLevel": "aggressive"
}
```

---

## 11.2 Balanced local mode

### Target models

- `gpt3.5-35B-A3B-Q4_K_M`

### Constraints

- search-first preferred
- allow 1 additional exploratory step
- max 3 file reads before required summary
- recovery after second empty output
- moderate compaction

### Recommended settings

```json
{
  "maxDiscoveryStepsBeforeRead": 2,
  "maxFileReadsBeforeSummary": 3,
  "allowBroadListingFirst": false,
  "emptyResponseRecoveryThreshold": 2,
  "historyCompactionLevel": "moderate"
}
```

---

## 11.3 High-capability mode

### Target models

- stronger hosted/local models

### Constraints

- search-first still preferred
- allow broader branching
- recovery logic still active
- lighter controller intervention

### Recommended settings

```json
{
  "maxDiscoveryStepsBeforeRead": 3,
  "maxFileReadsBeforeSummary": 4,
  "allowBroadListingFirst": false,
  "emptyResponseRecoveryThreshold": 2,
  "historyCompactionLevel": "light"
}
```

---

## 12. Prompting spec

## 12.1 System/developer prompt requirements

The repository-task prompt should:

- emphasize targeted action over broad planning
- require non-empty post-tool behavior
- bias toward reading one likely file at a time
- include task-class heuristics
- avoid vague “deliberate” language that increases stalls on smaller models

### Recommended base prompt

```md
You are a coding assistant for repository tasks.

For broad engineering requests:
- prefer targeted search and reading over broad exploration
- identify the most relevant file or files first
- inspect files one at a time
- after each tool result, either call one concrete next tool or answer
- never return an empty response

For performance or startup tasks, prioritize:
- entrypoints
- bootstrap code
- import logic
- module discovery
- cache logic
- version logic

Keep intermediate steps compact and action-oriented.
When enough evidence exists, summarize findings and propose the next code change.
```

---

## 12.2 Controller-injected recovery prompts

### Recovery prompt: first empty response

```md
You must do exactly one of the following:
1. call one specific next tool, or
2. answer directly using the current evidence.

Do not return an empty response.
```

### Recovery prompt: constrained candidate selection

```md
Choose exactly one file to inspect next from these candidates:
- app/startup.py
- plugins/loader.py
- utils/cache.py
- app/version.py

Call read_file or read_file_range on the single best target.
Do not use broad discovery again.
```

### Recovery prompt: answer-only fallback

```md
Tool use is now disabled for this turn.
Using the evidence already collected, provide the most likely diagnosis and recommended patch target.
```

---

## 13. Context compaction spec

## 13.1 Problem

Raw tool outputs often contain low-value bulk information that harms smaller models.

## 13.2 Requirement

After each tool result, the controller should generate or store a compact summary object.

### Example compact summary

```json
{
  "taskType": "performance_optimization",
  "discoverySummary": "Likely startup-related logic found in plugins/loader.py and app/startup.py.",
  "evidence": [
    "plugins/loader.py appears to enumerate modules dynamically.",
    "No versioned cache confirmed yet."
  ],
  "recommendedNextRead": "plugins/loader.py"
}
```

## 13.3 Raw-output retention

- Keep raw tool results available in logs
- Do not replay full raw outputs into the next prompt unless required
- Prefer summaries plus top snippets

---

## 14. Startup/performance heuristic pack

When the request involves startup or loading performance, the controller should seed search with:

```text
startup
bootstrap
initialize
importlib.import_module
pkgutil.iter_modules
__import__(
os.walk(
glob(
cache
version
discover
plugin
load_modules
scan_modules
```

It should also bias paths such as:

```text
app/
setup/
plugins/
bootstrap/
startup/
utils/
```

---

## 15. Decision rules

## 15.1 First-step rules

For broad codebase tasks:

- prefer search tools
- do not list the full repo first
- if search returns candidates, read one file immediately

## 15.2 Repeated discovery rules

Disallow:

- discovery -> discovery -> discovery without file inspection

Allow only if:

- the previous discovery returned no meaningful hits

## 15.3 Edit gating rules

Do not edit until the agent can state:

- the concrete file(s) to change
- the mechanism causing the issue
- the proposed fix strategy

---

## 16. Pseudocode

## 16.1 Main orchestration loop

```python
def handle_repo_task(request, model_profile, tools):
    task_type = classify_task(request)
    strategy = select_strategy(task_type, request, model_profile)

    state = {
        "discovery_steps": 0,
        "file_reads": 0,
        "empty_turns": 0,
        "evidence": [],
        "candidate_files": [],
    }

    while True:
        if should_start_with_search(state, strategy):
            result = run_discovery_tool(request, strategy, tools)
            state["discovery_steps"] += 1
            state["candidate_files"] = rank_candidates(result)
            state["evidence"].append(compact_discovery(result))

            next_action = validate_post_tool_step(
                allowed=["read_file", "read_file_range", "answer"]
            )

        elif should_read_file(state, strategy):
            target = choose_best_candidate(state["candidate_files"], state["evidence"])
            result = tools.read_file_range(target) if should_read_range(target) else tools.read_file(target)
            state["file_reads"] += 1
            state["evidence"].append(compact_file_read(result))

        elif should_summarize(state, strategy):
            summary = summarize_evidence(state["evidence"])
            if ready_for_patch(summary):
                return propose_patch(summary)
            if enough_to_answer(summary):
                return answer(summary)

        response = get_model_step()

        if is_empty(response):
            state["empty_turns"] += 1
            response = recover_from_empty(state, strategy)

        if is_tool_call(response):
            execute_tool(response)
        elif is_final_answer(response):
            return response
```

---

## 16.2 Empty-response recovery

```python
def recover_from_empty(state, strategy):
    if state["empty_turns"] == 1:
        return inject_prompt("non_empty_required")

    if state["empty_turns"] == 2:
        return inject_prompt(
            "choose_one_candidate_file",
            candidates=state["candidate_files"][:4]
        )

    return inject_prompt("answer_only")
```

---

## 17. Metrics and evaluation

## 17.1 Core metrics

Track per task:

- first tool selected
- whether first tool was broad or targeted
- number of empty post-tool turns
- number of discovery steps before first file read
- number of files read
- total token count
- final answer quality score
- task completion status

## 17.2 Derived metrics

### First-tool relevance rate

Percentage of tasks where the first tool was judged relevant.

### Stall rate

Percentage of tool transitions followed by empty model output.

### Over-discovery rate

Percentage of tasks with more than one discovery tool before first file read.

### Evidence efficiency

Useful file reads divided by total tool calls.

---

## 18. Acceptance criteria

### AC-1

On repository analysis tasks, at least 80% of sessions should begin with targeted search rather than broad directory listing.

### AC-2

Empty post-tool assistant turns should be reduced by at least 90% versus current baseline.

### AC-3

For startup/performance tasks on 9B models, the agent should read a relevant startup/bootstrap/import/cache/version file within the first two tool calls in at least 75% of cases.

### AC-4

Prompt token growth should be reduced through compaction without degrading final answer quality.

### AC-5

35B and stronger models should remain able to explore multiple relevant files when appropriate.

---

## 19. Rollout plan

## Phase 1: Controller and prompt fixes

Implement:

- search-first policy
- no-empty-response rule
- forced post-discovery file read
- compact recovery prompts
- model-tier presets

### Deliverables

- updated controller policy
- updated repository-task prompt
- empty-response recovery flow

---

## Phase 2: Tool improvements

Implement or prioritize:

- `search_code`
- `grep_repo`
- `read_file_range`

Optional:

- `search_symbols`
- `get_related_files`

### Deliverables

- tool contracts
- ranking output format
- snippet-based discovery responses

---

## Phase 3: Context compaction

Implement:

- compact evidence objects
- replacement of raw tool replay with summaries
- per-turn context compression rules

### Deliverables

- summary schema
- prompt assembly updates

---

## Phase 4: Benchmarking

Build a fixed evaluation suite of repository tasks:

- startup optimization
- trace a bug source
- add a feature
- explain system architecture
- find where config is loaded

### Deliverables

- benchmark set
- scorecard
- per-model comparisons

---

## 20. Risks and mitigations

## Risk 1: Overconstraining stronger models

### Mitigation

Use model-tier presets and allow more branching in high-capability mode.

## Risk 2: Search ranking returns weak candidates

### Mitigation

Return multiple candidates with snippets and let the controller force one read.

## Risk 3: Too much compaction removes needed detail

### Mitigation

Keep raw tool outputs in logs and allow targeted recall when needed.

## Risk 4: Recovery prompts become repetitive

### Mitigation

Keep recovery prompts short and state-based; do not stack many.

---

## 21. Example flow for the startup-cache task

## Request

> I want to speed up startup. Hundreds of Python modules are scanned or loaded. Cache these to a file keyed by current app version. Some of this may already exist.

## Expected flow

### Step 1

Classify as:

- performance optimization
- startup/module-loading/cache/version

### Step 2

Call:

```json
{
  "tool": "search_code",
  "args": {
    "queries": [
      "startup",
      "bootstrap",
      "importlib",
      "pkgutil.iter_modules",
      "cache",
      "version",
      "discover"
    ],
    "limit": 8,
    "preferEntrypoints": true
  }
}
```

### Step 3

Tool returns ranked candidates:

- `plugins/loader.py`
- `app/startup.py`
- `utils/cache.py`
- `app/version.py`

### Step 4

Agent reads `plugins/loader.py`

### Step 5

Evidence summary:

- dynamic module discovery found
- scanning occurs during startup
- no versioned disk cache confirmed yet
- next read should inspect cache/version helpers

### Step 6

Read `utils/cache.py` and `app/version.py`

### Step 7

Propose patch:

- add cache filename derived from app version
- load cached module list before scanning
- rebuild cache on missing/corrupt cache or version mismatch
- fall back to scan if cache invalid

---

## 22. Recommended implementation order

1. implement no-empty-response recovery
2. enforce search-first policy
3. enforce post-discovery file read
4. compact tool outputs
5. add `read_file_range`
6. add `search_code`
7. add model-tier presets
8. add `search_symbols`
9. add `get_related_files`
10. build benchmark harness

---

## 23. Appendix A: minimal tool output schemas

## `search_code`

```json
{
  "candidates": [
    {
      "path": "string",
      "score": 0.0,
      "reason": "string",
      "snippets": [
        {
          "line": 0,
          "text": "string"
        }
      ]
    }
  ],
  "recommendedNextRead": "string"
}
```

## `grep_repo`

```json
{
  "matches": [
    {
      "path": "string",
      "line": 0,
      "text": "string"
    }
  ]
}
```

## `read_file_range`

```json
{
  "path": "string",
  "startLine": 0,
  "endLine": 0,
  "content": "string"
}
```

---

## 24. Appendix B: minimal model profile schema

```json
{
  "modelName": "gpt3.5-9B-Q6K",
  "planningStrength": "low",
  "toolReliability": "medium",
  "stallRisk": "high",
  "contextTolerance": "low",
  "mode": "small_model_safe"
}
```

---

## 25. Summary

This spec introduces a controller-centered redesign for repository tasks:

- search before listing
- read one likely file immediately after discovery
- never allow empty post-tool turns
- compact context aggressively
- adapt constraints by model tier

For your common local models, this should materially improve first-step quality, reduce stalls, and produce more useful coding guidance without requiring a stronger model every time.

