import { describe, expect, it } from 'vitest';
import {
  composeSessionReadinessV1,
  type SessionReadinessFactsV1,
} from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { t } from '@/text';
import { presentSessionReadiness } from './sessionReadinessPresentation';

const yes = true;
const invocation: SessionReadinessFactsV1['invocation'] = { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: {
    readTranscript: yes, submitAgentInput: yes, editSessionRecords: yes, approveRuntimePermissions: yes, manageAccess: yes,
    managePermissionDelegation: yes, managePublicLink: yes, archiveSession: yes, renameSession: yes, assignResponsibility: yes,
    stopSession: yes, deleteSession: yes } };
const facts = (
  patch: Partial<SessionReadinessFactsV1>,
): SessionReadinessFactsV1 => ({
  configured: true,
  operation: 'conversation',
  machine: { status: 'ready', machineId: 'm1' },
  agent: {
    agentId: 'codex',
    state: 'ready',
    current: true,
    observedAtMs: 1,
    repair: null,
  },
  invocation,
  credential: { kind: 'not_required' },
  ...patch,
});
const signIn = {
  actionId: 'machines.agents.signIn.start',
  input: { machineId: 'm1', agentId: 'codex', method: 'native' },
} as const;
const present = (
  patch: Partial<SessionReadinessFactsV1>,
  repair: typeof signIn | null = null,
) =>
  presentSessionReadiness({
    readiness: composeSessionReadinessV1(facts(patch)),
    repair,
    demanded: true,
    loading: false,
    unavailableReason: null,
  });

describe('presentSessionReadiness', () => {
  it('never paints Ready for a closed, loading, failed or unknown read', () => {
    const base = {
      readiness: null,
      repair: null,
      loading: false,
      unavailableReason: null,
    };
    expect(presentSessionReadiness({ ...base, demanded: false }).tone).toBe(
      'unknown',
    );
    expect(
      presentSessionReadiness({ ...base, demanded: true, loading: true }).tone,
    ).toBe('unknown');
    expect(
      presentSessionReadiness({
        ...base,
        demanded: true,
        unavailableReason: 'unavailable',
      }),
    ).toMatchObject({ tone: 'unknown', repair: null });
    const probing = present({
      machine: { status: 'probing', machineId: 'm1' },
    });
    expect(probing.tone).toBe('unknown');
    expect(probing.title).not.toBe(t('session.collaboration.readiness.ready'));
  });

  it('says one Machine cause for an offline Bot and offers no borrowed repair', () => {
    const offline = present({
      machine: { status: 'offline', machineId: 'm1' },
    });
    expect(offline).toMatchObject({
      tone: 'attention',
      cause: t('session.collaboration.readiness.cause.machineOffline'),
      repair: null,
      guidance: null,
    });
  });

  it('offers the owner repair only when the status owner proposed it; otherwise who can fix it', () => {
    const needsSignIn = {
      agent: {
        agentId: 'codex',
        state: 'needsSignIn' as const,
        current: true,
        observedAtMs: 1,
        repair: signIn,
      },
    };
    const entitled = present(needsSignIn, signIn);
    expect(entitled.tone).toBe('attention');
    expect(entitled.repair?.repair).toBe(signIn);
    expect(entitled.guidance).toBeNull();
    const borrowed = present(
      { agent: { ...needsSignIn.agent, repair: null } },
      null,
    );
    expect(borrowed.repair).toBeNull();
    expect(borrowed.guidance).toBe(
      t('session.collaboration.readiness.ownerOnly'),
    );
  });

  it('is quiet when ready', () => {
    expect(present({})).toMatchObject({
      tone: 'ready',
      cause: null,
      repair: null,
      guidance: null,
    });
  });
});
