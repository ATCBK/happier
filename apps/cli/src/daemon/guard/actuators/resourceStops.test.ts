import { describe, expect, it } from 'vitest';
import { browserClose } from './browserClose';
import { serviceStop } from './serviceStop';
import type { GuardCandidate } from '../guardPlanner';

describe('memory guard captured native-owner actuators', () => {
  it('delegates browser disposal and service stop without treating native failure or missing owner as success', async () => {
    let nativeClosed = false;
    // Native launch/managed-service stop boundary. No private PID or consumer process controller.
    const root = { owner: { kind: 'browser_sidecar' as const }, pid: 1, start: { startTimeMs: 1 }, live: true,
      ownerCreatedAtMs: 0, stop: async () => { nativeClosed = true; } };
    const browser: GuardCandidate = { kind: 'browser', rung: 'browsers', step: 1, root,
      target: { kind: 'browser', root, label: 'Browser', ownerRef: root, idle: true, settledAt: 0 },
      footprintBytes: 20, settledAt: 0, attribution: { kind: 'unknown' } };
    expect(await browserClose(browser, new AbortController().signal)).toEqual({ status: 'stopped' });
    expect(nativeClosed).toBe(true);
    const serviceRoot = { ...root, owner: { kind: 'service' as const, serviceId: 's' }, stop: async () => { throw new Error('native'); } };
    const service: GuardCandidate = { ...browser, kind: 'service', rung: 'devServers', step: 2, root: serviceRoot,
      target: { kind: 'service', scope: 'project', root: serviceRoot, ownerRef: {}, label: 'Server', listeners: [{ establishedConnections: 0 }] } };
    expect(await serviceStop(service, new AbortController().signal)).toEqual({ status: 'failed', reason: 'native_stop_failed' });
    expect(await serviceStop({ ...service, target: { kind: 'service', scope: 'session', root: serviceRoot,
      ownerRef: {}, label: 'Plugin service', listeners: [{ establishedConnections: 0 }] } }, new AbortController().signal))
      .toEqual({ status: 'failed', reason: 'unsupported_target' });
    expect(await browserClose({ ...browser, root: { ...root, stop: undefined } }, new AbortController().signal))
      .toEqual({ status: 'failed', reason: 'unsupported_target' });
    const signal = new AbortController(); signal.abort(); nativeClosed = false;
    expect(await browserClose(browser, signal.signal)).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(nativeClosed).toBe(false);
  });
});
