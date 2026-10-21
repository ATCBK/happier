import { vi } from 'vitest';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildTestCodexRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptorV1 } from '@/testkit/runtimeDescriptorFixtures';

export function rawSession(id: string): RawSessionRecord {
  // Session-store boundary fixture: populate the persisted fields consumed by controls.
  return {
    id,
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
  } as unknown as RawSessionRecord;
}

export function metadata() {
  return {
    path: '/repo',
    host: 'host-local',
    machineId: 'machine-local',
    nativeResumeIdentityV1: { v: 1, vendorResumeId: 'thread-1' },
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
    }),
  };
}

export function commonRouteParams(sessionId: string) {
  return {
    token: 'token',
    sessionId,
    rawSession: rawSession(sessionId),
    metadata: metadata(),
    currentMachineId: 'machine-local',
    ctx: null,
    mode: 'plain' as const,
    callLiveSessionRpc: vi.fn(),
    // The daemon's durable mutation queue is a persistence boundary.
    stageWorkStateMutation: vi.fn(async () => undefined),
  };
}
