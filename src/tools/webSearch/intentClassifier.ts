/**
 * Deterministic intent classification for web search queries.
 * No LLM calls — v1 uses lightweight regex rules.
 */

export type SearchIntent = 'reference' | 'implementation' | 'debugging' | 'comparison' | 'general';

const DEBUGGING_RE = /\b(?:error|exception|crash|fail(?:ed|ure)?|undefined is not|cannot find module|not found|stack ?trace|type error|syntax error|traceback|segfault|segmentation fault)\b/i;
const COMPARISON_RE = /\b(?:vs\.?|versus|compar(?:e|ing|ison)|difference(?:s)? between|better than|which (?:is|should)|alternative(?:s)?)\b/i;
const IMPLEMENTATION_RE = /\b(?:how (?:to|do I|can I|should I)|implement(?:ing)?|build(?:ing)?|creat(?:e|ing)|writ(?:e|ing)|set ?up|integrat(?:e|ing)|add (?:a |an )?(?=\w))\b/i;
const REFERENCE_RE = /\b(?:what is|what are|how does|docs?|documentation|reference|api|syntax|explain)\b/i;

export function classifyIntent(query: string): SearchIntent {
  if (DEBUGGING_RE.test(query)) { return 'debugging'; }
  if (COMPARISON_RE.test(query)) { return 'comparison'; }
  if (IMPLEMENTATION_RE.test(query)) { return 'implementation'; }
  if (REFERENCE_RE.test(query)) { return 'reference'; }
  return 'general';
}
