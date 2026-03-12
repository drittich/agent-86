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
