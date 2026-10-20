/**
 * Follow-specific optional-context byte budget.
 *
 * This owner admits only fully rendered Follow blocks. The runtime must supply
 * an evidence-backed UTF-8 allowance; absence fails closed for optional Follow
 * context so an invented model window can never reject the real user input.
 */

import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';

const textEncoder = new TextEncoder();

/**
 * Measured 2026-09-08 with the official `@anthropic-ai/tokenizer` and
 * `js-tiktoken` `o200k_base` packages over fully framed 4 KiB ASCII, CJK,
 * emoji/ZWJ, combining-mark, and XML-escaped samples. The largest results were
 * 3,072 Anthropic tokens and 2,559 OpenAI tokens. Four KiB is the measured
 * owner-local optional block size; this establishes its tokenizer cost, not
 * provider headroom. It avoids publishing a byte/token equivalence, tokenizer
 * service, model registry, or user-facing setting.
 */
export const SESSION_FOLLOW_CONTEXT_V1_MEASURED_FALLBACK_UTF8_BYTES = 4_096;

export function measureSessionFollowUtf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export type SessionFollowContextAllowanceV1 = Readonly<{
  maxUtf8Bytes: number;
  basis: 'authoritative_remaining' | 'measured_fallback';
}>;

/**
 * Resolves Follow's allowance at the final provider-prompt composition owner.
 *
 * Provider tokenizers in the recorded measurement never produced more tokens
 * than UTF-8 bytes for the exercised provider-context corpus. The authoritative
 * arm therefore charges one whole remaining token for every required/follow
 * UTF-8 byte. This is intentionally conservative and is not an exact-token
 * claim. A derived estimate, unknown window, or snapshot for another active
 * model uses the independently measured fallback instead.
 */
export function resolveSessionFollowContextUtf8AllowanceV1(input: Readonly<{
  requiredPrompt: string;
  activeModelId: string | null;
  contextUsage: SessionContextUsageSnapshotV1 | null;
}>): SessionFollowContextAllowanceV1 {
  const usage = input.contextUsage;
  if (
    usage === null
    || usage.source === 'derived_estimate'
    || usage.windowTokens === null
    || usage.modelId === null
    || input.activeModelId === null
    || usage.modelId !== input.activeModelId
  ) {
    return {
      maxUtf8Bytes: SESSION_FOLLOW_CONTEXT_V1_MEASURED_FALLBACK_UTF8_BYTES,
      basis: 'measured_fallback',
    };
  }
  const remainingTokens = Math.max(0, Math.floor(usage.windowTokens - usage.usedTokens));
  const maxUtf8Bytes = Math.max(0, remainingTokens - measureSessionFollowUtf8Bytes(input.requiredPrompt));
  return { maxUtf8Bytes, basis: 'authoritative_remaining' };
}

export type SessionFollowBudgetEnvelopeV1 = Readonly<{
  sourceSessionId: string;
  /** Local packing address when multiple admitted originals share one source. */
  candidateId?: string;
  /** Selected original order within one source; unrelated sources retain recency priority. */
  sourceOriginalSeq?: number;
  /** Canonical source Session recency; transcript sequence is not cross-Session comparable. */
  sourceRecencyMs: number;
  actionableAttention: boolean;
  recentMessages: readonly Readonly<{ seq: number; text: string }>[];
  /** Ordinary Follow keeps the oldest pending prefix; initial snapshots keep the newest current suffix. */
  messageSelection?: 'oldest_pending_prefix' | 'latest_current_suffix';
  truncated: boolean;
  /** Renders the complete canonical block, including awareness/framing overhead. */
  render(input: Readonly<{ keptMessageSeqs: readonly number[]; truncated: boolean }>): string;
}>;

export type SessionFollowBudgetResultV1 = Readonly<{
  keptBySource: ReadonlyMap<string, readonly number[]>;
  truncatedBySource: ReadonlyMap<string, boolean>;
  omittedSources: readonly string[];
}>;

function compareBudgetEnvelopes(
  left: SessionFollowBudgetEnvelopeV1,
  right: SessionFollowBudgetEnvelopeV1,
): number {
  if (left.sourceSessionId === right.sourceSessionId
    && left.sourceOriginalSeq !== undefined && right.sourceOriginalSeq !== undefined
    && left.sourceOriginalSeq !== right.sourceOriginalSeq) return left.sourceOriginalSeq - right.sourceOriginalSeq;
  if (left.actionableAttention !== right.actionableAttention) {
    return left.actionableAttention ? -1 : 1;
  }
  if (right.sourceRecencyMs !== left.sourceRecencyMs) {
    return right.sourceRecencyMs - left.sourceRecencyMs;
  }
  return left.sourceSessionId < right.sourceSessionId ? -1 : left.sourceSessionId > right.sourceSessionId ? 1
    : (left.candidateId ?? '') < (right.candidateId ?? '') ? -1 : (left.candidateId ?? '') > (right.candidateId ?? '') ? 1 : 0;
}

function omittedResult(candidates: readonly SessionFollowBudgetEnvelopeV1[]): SessionFollowBudgetResultV1 {
  return {
    keptBySource: new Map(),
    truncatedBySource: new Map(),
    omittedSources: Object.freeze([...candidates].sort(compareBudgetEnvelopes).map((candidate) => candidate.candidateId ?? candidate.sourceSessionId)),
  };
}

/** Applies an authoritative byte allowance to complete rendered Follow blocks. */
export function applySessionFollowContextBudgetV1(input: Readonly<{
  candidates: readonly SessionFollowBudgetEnvelopeV1[];
  maxUtf8Bytes: number | null;
  measureBytes?: (text: string) => number;
}>): SessionFollowBudgetResultV1 {
  if (input.maxUtf8Bytes === null || !Number.isSafeInteger(input.maxUtf8Bytes) || input.maxUtf8Bytes <= 0) {
    return omittedResult(input.candidates);
  }

  const budget = input.maxUtf8Bytes;
  const measure = input.measureBytes ?? measureSessionFollowUtf8Bytes;
  const ordered = [...input.candidates].sort(compareBudgetEnvelopes);
  const keptBySource = new Map<string, readonly number[]>();
  const truncatedBySource = new Map<string, boolean>();
  const omittedSources: string[] = [];
  const deferredOriginalSources = new Set<string>();
  let used = 0;

  for (const candidate of ordered) {
    const candidateId = candidate.candidateId ?? candidate.sourceSessionId;
    if (candidate.sourceOriginalSeq !== undefined && deferredOriginalSources.has(candidate.sourceSessionId)) {
      omittedSources.push(candidateId);
      truncatedBySource.set(candidateId, true);
      continue;
    }
    const ascending = [...candidate.recentMessages].sort((a, b) => a.seq - b.seq);
    const allSeqs = Object.freeze(ascending.map((message) => message.seq));
    const completeCost = measure(candidate.render({
      keptMessageSeqs: allSeqs,
      truncated: candidate.truncated,
    }));
    let keptSeqs: readonly number[] = allSeqs;
    let sourceTruncated = candidate.truncated;
    if (used + completeCost > budget) {
      // A Follow transcript frontier is contiguous. Ordinary incremental delivery
      // keeps the oldest whole pending prefix. A current snapshot instead keeps the
      // newest whole suffix, because its ACK establishes the observed baseline rather
      // than claiming that every older message was rendered.
      const selected: number[] = [];
      sourceTruncated = true;
      const candidates = candidate.messageSelection === 'latest_current_suffix'
        ? [...ascending].reverse()
        : ascending;
      for (const message of candidates) {
        const proposed = Object.freeze(candidate.messageSelection === 'latest_current_suffix'
          ? [message.seq, ...selected]
          : [...selected, message.seq]);
        const cost = measure(candidate.render({ keptMessageSeqs: proposed, truncated: true }));
        if (used + cost <= budget) {
          selected.splice(0, selected.length, ...proposed);
        } else {
          break;
        }
      }
      keptSeqs = Object.freeze([...selected]);
    }

    const normalizedSeqs = Object.freeze([...keptSeqs]);
    if (normalizedSeqs.length !== candidate.recentMessages.length) sourceTruncated = true;
    const renderedCost = measure(candidate.render({ keptMessageSeqs: normalizedSeqs, truncated: sourceTruncated }));
    if (used + renderedCost > budget) {
      omittedSources.push(candidateId);
      truncatedBySource.set(candidateId, true);
      if (candidate.sourceOriginalSeq !== undefined) deferredOriginalSources.add(candidate.sourceSessionId);
      continue;
    }
    used += renderedCost;
    keptBySource.set(candidateId, normalizedSeqs);
    if (sourceTruncated) truncatedBySource.set(candidateId, true);
    // Distinct Pending originals share one source cursor. Once an original is
    // only partially represented, its later originals must stay pending too;
    // their smaller blocks cannot spend the remaining allowance out of order.
    if (candidate.sourceOriginalSeq !== undefined && normalizedSeqs.length !== allSeqs.length) {
      deferredOriginalSources.add(candidate.sourceSessionId);
    }
  }

  return { keptBySource, truncatedBySource, omittedSources: Object.freeze(omittedSources) };
}
