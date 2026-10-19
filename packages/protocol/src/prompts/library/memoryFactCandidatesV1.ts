import { tokenizeMemoryText } from '../../memory/memorySearchText.js';
import { MEMORY_ARCHIVE_TOPIC_TITLE_V1, type MemoryDocBodyV1, type MemoryFactV1 } from './memoryDocV1.js';
import type { MemoryDuplicateChoiceV1, MemoryDuplicateChoiceRequiredV1 } from './memoryActionsV1.js';
import type { MemoryDocMutationTargetV1 } from './promptLibraryActionOperations.js';
import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';

export type MemoryFactCandidateV1 = Readonly<{
  factId: string; topic?: string; text: string; decision?: MemoryFactV1['decision']; match: 'exact' | 'related';
}>;

const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Possible lexical matches in the already-admitted document; never semantic equality or cross-scope recall. */
export function findMemoryFactCandidatesV1(body: MemoryDocBodyV1, text: string, nowMs: number, excludeFactId?: string): MemoryFactCandidateV1[] {
  const normalized = normalize(text);
  const tokens = new Set(tokenizeMemoryText(text));
  const candidates: MemoryFactCandidateV1[] = [];
  const visit = (facts: readonly MemoryFactV1[], topic?: string) => {
    for (const fact of facts) {
      if (fact.id === excludeFactId || (fact.expiresAtMs !== undefined && fact.expiresAtMs <= nowMs)) continue;
      const match = normalize(fact.text) === normalized ? 'exact'
        : tokenizeMemoryText(fact.text).some(token => tokens.has(token)) ? 'related' : null;
      if (match) candidates.push({ factId: fact.id, text: fact.text, ...(fact.decision ? { decision: fact.decision } : {}),
        ...(topic === undefined ? {} : { topic }), match });
    }
  };
  visit(body.index);
  for (const topic of body.topics) if (topic.title !== MEMORY_ARCHIVE_TOPIC_TITLE_V1) visit(topic.facts, topic.title);
  return candidates.sort((a, b) => Number(b.match === 'exact') - Number(a.match === 'exact'));
}

/** One review policy used by Action preparation and the semantic mutation, including direct library adapters. */
export function reviewMemoryFactWriteV1(input: Readonly<{
  body: MemoryDocBodyV1; target: MemoryDocMutationTargetV1; text: string; nowMs: number;
  duplicateChoice?: MemoryDuplicateChoiceV1; excludeFactId?: string;
}>): MemoryDuplicateChoiceRequiredV1 | null {
  const choice = input.duplicateChoice;
  const revision = input.target.expectedRevision;
  if (choice && (choice.expectedRevision.headerVersion !== revision.headerVersion || choice.expectedRevision.bodyVersion !== revision.bodyVersion)) {
    throw Object.assign(new Error('version_mismatch'), { code: 'version_mismatch' });
  }
  if (choice) return null;
  const candidates = findMemoryFactCandidatesV1(input.body, redactBugReportSensitiveText(input.text), input.nowMs, input.excludeFactId);
  return candidates.length ? { ok: false, errorCode: 'memory_duplicate_choice_required', ref: input.target.ref, revision, candidates } : null;
}
