import { expect, it } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '../access/sessionEffectiveAccessV1.js';
import { composeSessionReadinessV1, SessionReadinessV1Schema, type SessionReadinessFactsV1 } from './sessionReadinessV1.js';

const facts: SessionReadinessFactsV1 = {
  configured: true, operation: 'conversation', machine: { status: 'ready', machineId: 'machine-1' },
  agent: { agentId: 'acme-agent', current: true, observedAtMs: 10, state: 'ready', repair: null },
  invocation: { v: 1, level: 'owner', sources: [], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
  credential: { kind: 'not_required' },
};

it('keeps optional integration failure independent of conversation, preserving the credential owner detail', () => {
  const credential = { kind: 'team' as const, teamId: 'team', resourceId: 'resource',
    readiness: { kind: 'limit_reached' as const, metric: 'inference_requests' as const, resetsAtUtc: '2026-10-19T00:00:00Z' },
    recoveryAction: 'source_owner_action' as const };
  const conversation = composeSessionReadinessV1({ ...facts, credential });
  expect(conversation.status).toBe('ready');
  const write = composeSessionReadinessV1({ ...facts, operation: 'credential', credential });
  expect(write).toMatchObject({ status: 'unavailable', cause: 'credential', credential });
  expect(SessionReadinessV1Schema.parse(write)).toEqual(write);
});

it('never certifies stale or missing sign-in and never reclassifies unsupported as offline', () => {
  expect(composeSessionReadinessV1({ ...facts, agent: null })).toMatchObject({ status: 'unknown', cause: 'agent' });
  expect(composeSessionReadinessV1({ ...facts, agent: { ...facts.agent!, current: false } })).toMatchObject({ status: 'unknown', cause: 'agent' });
  expect(composeSessionReadinessV1({ ...facts, agent: { ...facts.agent!, state: 'unsupported' } })).toMatchObject({ status: 'unavailable', cause: 'agent', machine: { status: 'ready' } });
  expect(composeSessionReadinessV1({ ...facts, operation: 'credential' })).toMatchObject({ status: 'unknown', cause: 'credential' });
});

it('preserves an exact entitled sign-in repair without executing it', () => {
  const repair = { actionId: 'machines.agents.signIn.start' as const, input: { machineId: 'machine-1', agentId: 'acme-agent', method: 'native' as const } };
  const result = composeSessionReadinessV1({ ...facts, agent: { ...facts.agent!, state: 'needsSignIn', repair } });
  expect(result).toMatchObject({ status: 'unavailable', cause: 'agent', agent: { repair } });
  expect(SessionReadinessV1Schema.parse(result)).toEqual(result);
  expect(SessionReadinessV1Schema.safeParse({ ...result, agent: { ...result.agent, token: 'secret' } }).success).toBe(false);
});
