import { describe, expect, it } from 'vitest';

import { buildTrackedSessionFromMarker, readTrackedSessionMaterializedStateObservationBinding } from './trackedSessionFromMarker';
import type { DaemonSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';

describe('buildTrackedSessionFromMarker', () => {
  it('restores the non-secret invocation context for an exact daemon runner marker', () => {
    const marker = {
      pid: 123,
      happySessionId: 'session-1',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      agentRuntimeDaemonServiceAuthorityFilePath: '/tmp/happier/authority.json',
    } satisfies DaemonSessionMarker;

    expect(buildTrackedSessionFromMarker({
      marker,
      startedByFallback: 'reattached',
      reattachedFromDiskMarker: true,
    }).runnerAgentInvocationContext).toEqual({
      cwd: '/tmp/project',
      environment: {},
      providerBindingActive: false,
    });
  });

  it('reads captured observation custody only from one exact, unretired tracked Session', () => {
    const binding: NonNullable<TrackedSession['materializedStateObservationBinding']> = {
      agentId: 'fixture-agent', pluginId: 'fixture-plugin',
      sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
      nativeHomeRoot: '/private/native-home',
      entries: [{ entryPath: 'projects', sourceEntryRoot: '/native/projects', materializedEntryPath: '/private/native-home/projects' }],
    };
    const tracked: TrackedSession = { startedBy: 'daemon', pid: 123, happySessionId: 'session-1', materializedStateObservationBinding: binding };
    expect(readTrackedSessionMaterializedStateObservationBinding([tracked], 'session-1')).toBe(binding);
    expect(readTrackedSessionMaterializedStateObservationBinding([tracked], '')).toBeNull();
    expect(readTrackedSessionMaterializedStateObservationBinding([tracked], 'other-session')).toBeNull();
    expect(readTrackedSessionMaterializedStateObservationBinding([tracked, { ...tracked, pid: 456 }], 'session-1')).toBeNull();
    expect(readTrackedSessionMaterializedStateObservationBinding([{ ...tracked, materializedStateObservationBinding: undefined }], 'session-1')).toBeNull();
    tracked.reportMarkerCustody = { pending: Promise.resolve(), retiring: true };
    expect(readTrackedSessionMaterializedStateObservationBinding([tracked], 'session-1')).toBeNull();
  });
});
