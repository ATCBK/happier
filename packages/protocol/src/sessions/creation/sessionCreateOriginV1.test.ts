import { describe, expect, it } from 'vitest';

import { SessionCreateOriginFieldsV1Schema } from './sessionCreateOriginV1.js';
import { SessionAwarenessOriginV1Schema } from '../awareness/projectionV1.js';

describe('authenticated host Session creation facts', () => {
  it('accepts originless predecessor creation and exact current origin arms', () => {
    expect(SessionCreateOriginFieldsV1Schema.parse({})).toEqual({});
    for (const fields of [
      { originKind: 'none', workDepth: 0 },
      { originKind: 'session', originSessionId: 'session-1', workDepth: 37 },
      { originKind: 'execution_run', originSessionId: 'host-session', workDepth: 37 },
      { originKind: 'run_step', originRunId: 'workflow-run', workDepth: 37 },
    ]) {
      expect(SessionCreateOriginFieldsV1Schema.parse(fields)).toEqual(fields);
    }
  });

  it('binds a Discussion birth to its exact slot without a fabricated parent', () => {
    const discussionParticipant = { discussionId: 'discussion-1', participantSlotId: 'slot-1' };
    const discussionParticipantLaunch = { executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const fields = { originKind: 'discussion', discussionParticipant, discussionParticipantLaunch, workDepth: 37 };
    expect(SessionCreateOriginFieldsV1Schema.parse(fields)).toEqual(fields);
    for (const invalid of [
      { originKind: 'discussion' },
      { originKind: 'discussion', discussionParticipant },
      { ...fields, originSessionId: 'unrelated-anchor' },
      { ...fields, originRunId: 'unrelated-run' },
      { ...fields, discussionParticipant: { ...discussionParticipant, accountId: 'forged' } },
      { originKind: 'none', discussionParticipant },
    ]) expect(SessionCreateOriginFieldsV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('projects Discussion provenance with the same strict slot identity', () => {
    const origin = { kind: 'discussion', discussionParticipant: { discussionId: 'discussion-1', participantSlotId: 'slot-1' } };
    expect(SessionAwarenessOriginV1Schema.parse(origin)).toEqual(origin);
    expect(SessionAwarenessOriginV1Schema.safeParse({ kind: 'discussion' }).success).toBe(false);
    expect(SessionAwarenessOriginV1Schema.safeParse({ ...origin, kind: 'session' }).success).toBe(false);
  });

  it('refuses inconsistent identities, unknown authority and unpersistable depths', () => {
    for (const fields of [
      { originKind: 'none', originSessionId: 'session-1' },
      { originKind: 'session' },
      { originKind: 'execution_run', originRunId: 'local-run' },
      { originKind: 'run_step' },
      { originKind: 'session', originSessionId: 'session-1', originRunId: 'run-1' },
      { originKind: 'none', causeSessionId: 'session-1' },
      { workDepth: -1 },
      { workDepth: 1.5 },
      { workDepth: 2_147_483_648 },
    ]) {
      expect(SessionCreateOriginFieldsV1Schema.safeParse(fields).success).toBe(false);
    }
  });
});
