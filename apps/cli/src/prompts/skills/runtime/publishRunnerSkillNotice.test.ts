import { describe, expect, it } from 'vitest';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import type { RunnerSkillsResult } from './resolveRunnerSkills';
import { publishRunnerSkillNotice, publishSkillLaunchNotice } from './publishRunnerSkillNotice';

describe('runner skill failure notice', () => {
  it('carries the preparation reason when no library item could be resolved', async () => {
    const events: unknown[] = [];
    const session = { enqueueSessionEventCommitted: async (event: unknown) => {
      events.push(event); return { persisted: true as const, delivered: false as const };
    } };
    await publishRunnerSkillNotice(session, { plan: { plan: 'session_dir', items: [], nativeDisables: [], diagnostics: [] },
      indexItems: [], unavailable: true, unavailableReason: 'skill_rules_unavailable' });
    expect(readSessionCapabilityNoticeV1(events[0])?.items).toEqual([
      { kind: 'skill', name: 'Skills', code: 'skills_unavailable', detail: 'skill_rules_unavailable' },
    ]);
  });
  it('explains a failed native scan even when there are no selected library items', async () => {
    const events: unknown[] = [];
    const session = { enqueueSessionEventCommitted: async (event: unknown) => {
      events.push(event); return { persisted: true as const, delivered: false as const };
    } };
    await publishRunnerSkillNotice(session, { plan: { plan: 'session_dir', items: [], nativeDisables: [],
      diagnostics: [{ kind: 'native_scan_failed', root: '/native/skills' }] }, indexItems: [] });
    expect(readSessionCapabilityNoticeV1(events[0])?.items[0]?.detail).toBe('native_scan_failed');
  });
  it('reports refused native-disable-only delivery, without warning for an empty carrier', async () => {
    const nativeDisables = [{ name: 'native-review', path: '/native/review/SKILL.md' }];
    const delivery = { pluginRoot: '/session', skillsRoot: '/session/skills', items: [], nativeDisables };
    const result: RunnerSkillsResult = { delivery, plan: { plan: 'session_dir', items: [],
      nativeDisables: nativeDisables.map(item => ({ ...item, state: 'applied' })), diagnostics: [] }, indexItems: [] };
    const expected = [{ v: 1, items: [{ kind: 'skill', name: 'Skills', code: 'skills_unavailable', detail: 'launch_path_unsupported' }] }];
    for (const writer of ['runner', 'launch'] as const) {
      const events: unknown[] = [];
      const session = { enqueueSessionEventCommitted: async (event: unknown) => {
        events.push(event); return { persisted: true as const, delivered: false as const };
      } };
      if (writer === 'runner') await publishRunnerSkillNotice(session, result, false);
      else await publishSkillLaunchNotice(session, delivery);
      expect(events.map(readSessionCapabilityNoticeV1), writer).toEqual(expected);
      events.length = 0;
      const emptyDelivery = { ...delivery, nativeDisables: [] };
      if (writer === 'runner') await publishRunnerSkillNotice(session, {
        ...result, delivery: emptyDelivery, plan: { ...result.plan, nativeDisables: [] },
      }, false);
      else await publishSkillLaunchNotice(session, emptyDelivery);
      expect(events.map(readSessionCapabilityNoticeV1), `${writer} empty carrier`).toEqual([]);
    }
  });
  it('preserves the failed item filesystem diagnostic at the visible Session boundary', async () => {
    const events: unknown[] = [];
    // Committed Session event delivery is the external persistence/transport boundary.
    const session = { enqueueSessionEventCommitted: async (event: unknown) => {
      events.push(event); return { persisted: true as const, delivered: false as const };
    } };
    const result = { plan: { plan: 'session_dir', items: [{ skillId: 'failed-skill', name: 'review', digest: 'sha256:review',
      state: 'unavailable', reason: 'materialize_failed' }], nativeDisables: [], diagnostics: [] }, indexItems: [],
      failureDetails: [{ skillId: 'other-skill', detail: 'ENOSPC' }, { skillId: 'failed-skill', detail: 'EACCES' }],
    } satisfies RunnerSkillsResult;
    await publishRunnerSkillNotice(session, result);
    expect(readSessionCapabilityNoticeV1(events[0])).toEqual({ v: 1, items: [{ kind: 'skill', name: 'review',
      itemId: 'failed-skill', code: 'skills_unavailable', detail: 'EACCES' }] });
    await publishRunnerSkillNotice(session, { ...result, plan: { ...result.plan, items: [
      ...result.plan.items, { skillId: 'launch-skill', name: 'launch', digest: 'sha256:launch', state: 'delivered', reason: 'rule_on' },
    ] } }, false);
    // The first publication already reported materialization failures for this start.
    // The native-open publication reports only its newly observed refusal.
    expect(readSessionCapabilityNoticeV1(events[1])).toEqual({ v: 1, items: [
      { kind: 'skill', name: 'launch', itemId: 'launch-skill', code: 'skills_unavailable', detail: 'launch_path_unsupported' },
    ] });
  });
});
