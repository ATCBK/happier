import { describe, expect, it } from 'vitest';
import {
  MachineProcessesAnswerV1Schema, MachineProcessesKillInputV1Schema, MachineProcessesWatchResultV1Schema,
  NotHappierRowV1Schema, ProcessOwnerRefV1Schema,
  MachineProcessesStartAgainInputV1Schema, MachineProcessesStartAgainResultV1Schema,
} from './machineProcessesV1.js';

describe('Machine Processes V1 wire privacy and identity', () => {
  const notHappier = { name: 'Editor', appGroup: 'Editor', pid: 70, ref: 'identity-ref', memoryBytes: 20 };
  const totals = { memoryBytes: 0, processCount: 0 };
  it('refuses private process details recursively on non-Happier rows', () => {
    const answer = { v: 1, machineId: 'm', capturedAtMs: 1, state: 'live', platform: 'linux', evidenceModel: 'fenced',
      owners: [], leftBehind: [], notHappier: [{ appGroup: 'Editor', members: [notHappier] }], totals: { happier: totals, leftBehind: totals } };
    expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
    for (const field of ['command', 'argv', 'cwd', 'ownerTag', 'owner'] as const) {
      expect(NotHappierRowV1Schema.safeParse({ ...notHappier, [field]: 'secret' }).success, field).toBe(false);
      expect(MachineProcessesAnswerV1Schema.safeParse({ ...answer,
        notHappier: [{ appGroup: 'Editor', members: [{ ...notHappier, [field]: 'secret' }] }] }).success, field).toBe(false);
    }
  });
  it('rejects added authority and duplicated reviewed identities without imposing a set cap', () => {
    const item = { ref: 'opaque', expect: { level: 'proven', owner: { kind: 'session', sessionId: 's' } } };
    const input = { machineId: 'm', targets: [item], tree: true };
    expect(MachineProcessesKillInputV1Schema.safeParse(input).success).toBe(true);
    expect(MachineProcessesKillInputV1Schema.safeParse({ ...input, actorAccountId: 'other' }).success).toBe(false);
    expect(MachineProcessesKillInputV1Schema.safeParse({ ...input, targets: [{ ...item, expect: { ...item.expect, approved: true } }] }).success).toBe(false);
    expect(MachineProcessesKillInputV1Schema.safeParse({ ...input, targets: [item, item] }).success).toBe(false);
    expect(MachineProcessesKillInputV1Schema.safeParse({ ...input,
      targets: Array.from({ length: 300 }, (_, n) => ({ ...item, ref: `ref-${n}` })) }).success).toBe(true);
    expect(ProcessOwnerRefV1Schema.safeParse({ kind: 'session', sessionId: 's', accountId: 'other' }).success).toBe(false);
    expect(MachineProcessesWatchResultV1Schema.safeParse({ changed: false, answer: {} }).success).toBe(false);
  });
  it('carries the canonical launcher review result and original request without opening process input or output bags', () => {
    const request = { machineId: 'm', targetId: 'managed:web', expectedEffectDigest: 'a'.repeat(64) };
    const response = { protocolVersion: 1, machineId: 'm', targetId: 'managed:web', status: 'denied',
      reasonCode: 'effect_review_required', reviewedEffect: { command: 'npm run web' }, reviewedEffectDigest: 'b'.repeat(64),
      snapshot: { v: 1, machineId: 'm', updatedAt: 1, targets: [{ id: 'managed:web', source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'web' }, machineId: 'm', title: 'Web',
        confidence: 'high', state: 'available', actions: ['start'] }] } };
    const result = { status: 'refused', reasonCode: 'effect_review_required', serviceStart: { request, response } };
    expect(MachineProcessesStartAgainResultV1Schema.safeParse(result).success).toBe(true);
    expect(MachineProcessesStartAgainInputV1Schema.safeParse({ machineId: 'm', ref: 'opaque', serviceStart: { request, response } }).success).toBe(false);
    for (const field of ['command', 'cwd', 'privateBag'] as const) {
      expect(MachineProcessesStartAgainResultV1Schema.safeParse({ ...result, [field]: 'secret' }).success).toBe(false);
      expect(MachineProcessesStartAgainResultV1Schema.safeParse({ ...result,
        serviceStart: { ...result.serviceStart, [field]: 'secret' } }).success).toBe(false);
      expect(MachineProcessesStartAgainResultV1Schema.safeParse({ ...result,
        serviceStart: { request: { ...request, [field]: 'secret' }, response } }).success).toBe(false);
      expect(MachineProcessesStartAgainResultV1Schema.safeParse({ ...result,
        serviceStart: { request, response: { ...response, [field]: 'secret' } } }).success).toBe(false);
    }
    expect(MachineProcessesStartAgainResultV1Schema.safeParse({ ...result,
      serviceStart: { request: { ...request, machineId: 'other' }, response } }).success).toBe(false);
    expect(MachineProcessesStartAgainResultV1Schema.safeParse({ ...result,
      serviceStart: { request: { ...request, targetId: 'other' }, response } }).success).toBe(false);
  });
});
