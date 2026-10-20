import { describe, expect, it } from 'vitest';
import {
  clearSessionExplicitStopV1FromMetadata,
  resolveSessionAutoResumeAdmissionV1,
  writeSessionExplicitStopV1ToMetadata,
} from './sessionExplicitStopV1.js';

describe('automatic Session resume admission', () => {
  const stop = { v: 1, cause: 'explicit_stop', requestId: 'stop-request-1', requestedAtMs: 123 } as const;

  it('admits ordinary inactivity but holds an explicit Stop after reloading', () => {
    const admission = (metadata: unknown) => resolveSessionAutoResumeAdmissionV1({
      metadata, machineAvailable: true, authorityAvailable: true,
    });
    expect(admission({})).toBe('eligible');
    const reloaded = JSON.parse(JSON.stringify(writeSessionExplicitStopV1ToMetadata({}, stop)));
    expect(admission(reloaded)).toBe('held_by_person');
    expect(admission(clearSessionExplicitStopV1FromMetadata(reloaded, stop.requestId))).toBe('eligible');
  });

  it('keeps archive, unavailable authority and offline admission distinct', () => {
    const base = { metadata: {}, machineAvailable: true, authorityAvailable: true };
    expect(resolveSessionAutoResumeAdmissionV1({ ...base, archivedAt: 1 })).toBe('archived');
    expect(resolveSessionAutoResumeAdmissionV1({ ...base, machineAvailable: false })).toBe('machine_unavailable');
    expect(resolveSessionAutoResumeAdmissionV1({ ...base, authorityAvailable: false })).toBe('authority_unavailable');
    expect(resolveSessionAutoResumeAdmissionV1({ ...base, metadata: null })).toBe('authority_unavailable');
    expect(resolveSessionAutoResumeAdmissionV1({ ...base, metadata: { sessionExplicitStopV1: {} } })).toBe('authority_unavailable');
    expect(resolveSessionAutoResumeAdmissionV1({ ...base, metadata: writeSessionExplicitStopV1ToMetadata({}, stop), machineAvailable: false })).toBe('held_by_person');
  });
});
