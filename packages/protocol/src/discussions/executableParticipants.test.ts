import { describe, expect, it } from 'vitest';
import { ExecutableParticipantSelectionV1Schema, normalizeExecutableParticipantSelectionV1 } from './index.js';
import { SessionSpawnNewInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';

const launch = SessionSpawnNewInputV2Schema.parse({
  executionTarget: { serverId: 'home-a', machineId: 'machine-a' },
  directory: { kind: 'path', path: '/work' },
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  permissionMode: 'read-only',
});

describe('executable participant selection', () => {
  it('publishes one strict read-only choice normalizer for Session, Bot and model consumers', () => {
    const normalizeChoice = normalizeExecutableParticipantSelectionV1;
    const session = { serverId: 'home-a', sessionId: 'session-a' };
    expect(normalizeChoice({ kind: 'session', session })).toEqual({ kind: 'session', session });
    expect(normalizeChoice({ kind: 'bot', session })).toEqual({ kind: 'session', session });
    expect(normalizeChoice({ kind: 'model', launch })).toEqual({ kind: 'model', launch });
    expect(ExecutableParticipantSelectionV1Schema.parse(normalizeChoice({ kind: 'bot', session })))
      .toEqual({ kind: 'session', session });
    expect(ExecutableParticipantSelectionV1Schema.safeParse({ kind: 'bot', session }).success).toBe(false);
    for (const value of [
      { kind: 'account', accountId: 'person-a' },
      { kind: 'session', session, launch },
      { kind: 'session', session: { ...session, machineId: 'asserted-machine' } },
      { kind: 'model', launch, session },
      { kind: 'model', launch: { ...launch, initialInput: { text: 'Run now' } } },
      { kind: 'model', launch: { ...launch, discussionParticipant: { discussionId: 'd', participantSlotId: 's' } } },
      { kind: 'bot', sessionId: 'display-only' },
    ]) expect(normalizeChoice(value)).toBeNull();
  });
});
