import { IProvider, ChatMessage, ILogger } from '../providers/IProvider';

/**
 * Fixed-function verification of a finished plan step.
 *
 * This is a single stateless LLM call with a harness-written prompt — a
 * subroutine, not an agent. Small models are much better judges than
 * executors, so a cheap fresh-context "was this step actually done?" check
 * catches drift before it compounds across steps.
 */

export interface PlanItemVerdict {
  pass: boolean;
  critique: string;
}

const VERIFIER_TIMEOUT_MS = 60_000;

const VERIFIER_SYSTEM = [
  'You are a reviewer judging whether one step of a coding plan was completed.',
  'You will be given the step and evidence of what an agent did (files read, edits made, commands run, and the agent\'s own summary).',
  'Rules:',
  '- If the step required changing files and the evidence shows no successful edits, the verdict is FAIL.',
  '- If the evidence shows the described work was done without errors, the verdict is PASS. Do not fail for style, or because work belonging to other steps was not done.',
  '- If the evidence is ambiguous, lean PASS.',
  'Reply with exactly two lines and nothing else:',
  'VERDICT: PASS or FAIL',
  'REASON: one short sentence',
].join('\n');

/**
 * Run the verifier. Returns null when the verdict is unavailable (provider
 * error, timeout, unparseable output) — callers must treat null as "accept",
 * never as a failure.
 */
export async function verifyPlanItem(
  provider: IProvider,
  opts: {
    itemText: string;
    evidence: string;
    extraBody?: Record<string, unknown>;
  },
  log?: ILogger
): Promise<PlanItemVerdict | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: VERIFIER_SYSTEM },
    {
      role: 'user',
      content: `Plan step:\n${opts.itemText}\n\nEvidence of what the agent did:\n${opts.evidence}`,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFIER_TIMEOUT_MS);
  let text = '';
  let streamErrored = false;
  try {
    await provider.stream(
      messages,
      controller.signal,
      (event) => {
        if (event.type === 'delta') {
          text += event.content;
        } else if (event.type === 'error') {
          streamErrored = true;
        }
      },
      { thinkingMode: false, extraBody: opts.extraBody }
    );
  } catch (err) {
    log?.appendLine(`[verify] verifier call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  const verdictMatch = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  if (!verdictMatch) {
    if (streamErrored || !text.trim()) {
      log?.appendLine('[verify] verifier produced no usable output');
    } else {
      log?.appendLine(`[verify] unparseable verdict: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
    }
    return null;
  }

  const pass = verdictMatch[1].toUpperCase() === 'PASS';
  const reasonMatch = /REASON:\s*(.+)/i.exec(text);
  const critique = (reasonMatch?.[1] ?? '').trim().slice(0, 300);
  log?.appendLine(`[verify] verdict=${pass ? 'PASS' : 'FAIL'}${critique ? ` reason=${critique}` : ''}`);
  return { pass, critique };
}
