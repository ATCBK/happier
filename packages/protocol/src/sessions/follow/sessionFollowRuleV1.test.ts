import { describe, expect, it } from 'vitest';
import { openSessionFollowRuleContentV1, sealSessionFollowRuleContentV1 } from './sessionFollowRuleContentCodecV1.js';
import { SessionFollowRuleDefinitionV1Schema,
  buildSessionFollowRulePhysicalKeyV1, parseSessionFollowRulePhysicalKeyV1 } from './sessionFollowRuleV1.js';
import { SessionFollowRuleStoredRowV1Schema, SessionFollowRuleV1Schema } from './sessionFollowRuleV1.js';
import { OpenedSessionFollowRuleV1Schema } from './actions.js';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from './sessionFollowFrontierV1.js';

const definition = SessionFollowRuleDefinitionV1Schema.parse({ v: 1, enabled: true, policy: { preset: 'important' },
  filter: { show: 'both', startedBy: ['you'], scope: 'all_accessible', attention: 'any', homeServerIds: ['home'], audiences: [], tagIds: [], source: 'all' } });
const receiver = { kind: 'session', sessionId: 'coordinator' } as const;
const material = { type: 'dataKey', machineKey: new Uint8Array(32).fill(23) } as const;

describe('private Follow rule content', () => {
  it('retains one canonical source frontier without changing the private authoring version', () => {
    const source = { sourceSessionId: 'source', delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 5 } };
    const row = { version: 2, receiver, content: { t: 'plain', v: definition }, sources: [source] };
    expect(SessionFollowRuleStoredRowV1Schema.safeParse(row).success).toBe(true);
    expect(SessionFollowRuleStoredRowV1Schema.safeParse({ ...row, sources: [source, source] }).success).toBe(false);
    expect(SessionFollowRuleV1Schema.parse({ ruleId: 'rule', ...row }).sources).toEqual([source]);
    expect(OpenedSessionFollowRuleV1Schema.parse({ ruleId: 'rule', version: row.version,
      receiver, definition, sources: [source] }).sources).toEqual([source]);
  });
  it('round-trips keyless plain and encrypted rules while binding rule and receiver identities', () => {
    const encrypted = sealSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, definition, mode: 'e2ee', material });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'e2ee', material })).toEqual({ status: 'opened', definition });
    for (const identity of [{ ruleId: 'rule-b', receiver }, { ruleId: 'rule-a', receiver: { kind: 'account' } as const }]) {
      expect(openSessionFollowRuleContentV1({ ...identity, content: encrypted, mode: 'e2ee', material })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    }
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'e2ee', material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(24) } })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    const plain = sealSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, definition, mode: 'plain', material: null });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: plain, mode: 'plain', material: null })).toEqual({ status: 'opened', definition });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: plain, mode: 'e2ee', material })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'plain', material: null })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(openSessionFollowRuleContentV1({ ruleId: 'rule-a', receiver, content: encrypted, mode: 'e2ee', material: null })).toEqual({ status: 'unavailable', reason: 'encryption-material-unavailable' });
  });

  it('keeps encoded rule identities canonical and denies mutation fields outside the definition', () => {
    const ruleId = 'project/payments %';
    expect(parseSessionFollowRulePhysicalKeyV1(buildSessionFollowRulePhysicalKeyV1(ruleId))).toBe(ruleId);
    expect(parseSessionFollowRulePhysicalKeyV1('@happier/account/session-follow-rules/v1/project/payments')).toBeNull();
    expect(SessionFollowRuleDefinitionV1Schema.safeParse({ ...definition, accountId: 'other' }).success).toBe(false);
  });
});
