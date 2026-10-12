import { describe, expect, it } from 'vitest';

import {
  DaemonExecutionRunMarkerPersistenceReadSchema,
  ExecutionRunConnectedServicesLaunchV1Schema,
  normalizePersistedExecutionRunConnectedServicesLaunchV1,
} from './executionRuns.js';

describe('retained execution-run launch facts', () => {
  it.each(['current', 'legacy', 'remote'] as const)('opens %s facts and encoded selections with retired fields', (source) => {
    const serviceId = source === 'current' ? 'happier.agent.codex/openai-codex' : 'openai-codex';
    const selection = { kind: 'profile', serviceId, profileId: 'profile_1' };
    const selectionsJson = JSON.stringify([{ ...selection, retiredField: true }]);
    const connectedServicesBindings = { v: source === 'current' ? 2 : 1, retiredField: true,
      bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId: 'profile_1', retiredField: true } } };
    const runKey = source === 'remote' ? 'execution_run:11111111-1111-4111-8111-111111111111' : 'run_1';
    const launch = source === 'remote'
      ? { v: 1, retiredField: true, agentId: 'codex', runKey,
          connectedServicesBindings, connectedServiceSelectionsJson: selectionsJson, materializedRoot: '/materialized' }
      : { v: 1, retiredField: true, agentId: 'codex', runKey, materializationKey: 'run_1',
          connectedServicesBindings, connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: selectionsJson },
          sessionDirectory: null, materializedRoot: '/materialized' };
    expect(ExecutionRunConnectedServicesLaunchV1Schema.safeParse(launch).success).toBe(false);
    const normalized = normalizePersistedExecutionRunConnectedServicesLaunchV1(launch);
    expect(normalized?.registration.connectedServicesBindings).toEqual({ v: 2,
      bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' } } });
    expect(normalized?.registration.connectedServiceSelectionsEnv).toEqual({ HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON:
      JSON.stringify([{ ...selection, serviceId: 'happier.agent.codex/openai-codex' }]) });
    expect(normalized?.registration).not.toHaveProperty('retiredField');
    const marker = DaemonExecutionRunMarkerPersistenceReadSchema.parse({ pid: 123, happySessionId: 'session_1',
      runId: source === 'remote' ? 'run_22222222-2222-4222-8222-222222222222' : runKey,
      callId: 'call_1', sidechainId: 'side_1', intent: 'review', backendTarget: { kind: 'backend', backendId: 'codex' },
      status: 'running', startedAtMs: 1, updatedAtMs: 1, executionRunConnectedServicesLaunchV1: launch });
    expect(JSON.stringify(marker)).not.toContain('retiredField');
    if (source === 'current') {
      expect(normalizePersistedExecutionRunConnectedServicesLaunchV1({ ...launch,
        runKey: 'execution_run:11111111-1111-4111-8111-111111111111', activationId: 'invalid',
      })).toBeNull();
    }
  });
});
