import { describe, expect, it } from 'vitest';

import { listSessionPresentationStatesForWorkStatusFilterV1, readSessionAwarenessPresentationV1, readSessionAwarenessWorkStatusV1, readSessionWorkStateGroupV1, readSessionManagedSessionsPresentationV1 } from './presentationV1.js';

describe('readSessionAwarenessWorkStatusV1', () => {
  it('keeps background activity in Working and its status filter until it settles', () => {
    const awareness = { runtime: 'background_active', encryption: 'plain', operational: { primary: 'none' } } as const;
    const status = readSessionAwarenessWorkStatusV1({ awareness, settled: true });
    expect(status).toEqual({ bucket: 'working', tone: 'neutral' });
    expect(readSessionWorkStateGroupV1(status.bucket)).toBe('working');
    expect(listSessionPresentationStatesForWorkStatusFilterV1('working')).toContain('background_active');
    expect(readSessionAwarenessWorkStatusV1({ awareness: { ...awareness, runtime: 'idle' }, settled: true }))
      .toEqual({ bucket: 'finished', tone: 'neutral' });
  });
  it('does not turn offline in-flight reports into working reports in a summary', () => {
    expect(readSessionManagedSessionsPresentationV1({ working: 0, needsYou: 0, stalled: 4 }))
      .toEqual({ bucket: 'offline', count: 4 });
    expect(readSessionManagedSessionsPresentationV1({ working: 1, needsYou: 0, stalled: 3 }))
      .toEqual({ bucket: 'working', count: 1 });
    expect(readSessionManagedSessionsPresentationV1({ working: 1, needsYou: 2, stalled: 3 }))
      .toEqual({ bucket: 'needs_you', count: 2 });
    expect(readSessionManagedSessionsPresentationV1({ working: 0, needsYou: 0, stalled: 0 }))
      .toEqual({ bucket: 'idle', count: 0 });
  });
  it('preserves public offline status while content hydration is undecided', () => {
    const awareness = { runtime: 'offline', encryption: 'unknown', operational: { primary: 'working' } } as const;
    expect(readSessionAwarenessPresentationV1(awareness)).toBe('disconnected');
    expect(readSessionAwarenessWorkStatusV1({ awareness })).toEqual({ bucket: 'offline', tone: 'neutral' });
    // A settled content failure still explains its own recovery, rather than reading as hydrated.
    expect(readSessionAwarenessPresentationV1({ ...awareness, encryption: 'repair_needed' })).toBe('repair_needed');
  });

  it('keeps disconnected work quiet and in Recent, even with previous settlement', () => {
    for (const settled of [false, true]) {
      const status = readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary: 'none' } }, settled,
      });
      expect(status).toEqual({ bucket: 'offline', tone: 'neutral' });
      expect(readSessionWorkStateGroupV1(status.bucket)).toBe('recent');
    }
  });

  it('does not claim actionable work when its runtime cannot serve it', () => {
    for (const primary of ['permission_required', 'action_required', 'failed'] as const) {
      expect(readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary } }, settled: true,
      })).toEqual({ bucket: 'offline', tone: 'neutral' });
    }
  });

  it('keeps unreadable content and offline or stale runtimes out of Needs you', () => {
    for (const primary of ['failed', 'permission_required', 'action_required', 'working'] as const) {
      for (const encryption of ['locked', 'preparing', 'repair_needed', 'access_pending', 'setup_required', 'content_unavailable', 'unknown'] as const) {
        expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'working', encryption,
          operational: { primary } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
      }
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', encryption: 'ready',
        operational: { primary } } })).toEqual({ bucket: 'offline', tone: 'neutral' });
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'working', freshness: 'stale',
        encryption: 'plain', operational: { primary } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
    }
  });

  it('preserves known operational facts without manufacturing runtime reachability', () => {
    for (const primary of ['failed', 'permission_required', 'action_required', 'working', 'ready', 'pending_input', 'none'] as const) {
      const awareness = { runtime: 'unknown', freshness: 'unknown', encryption: 'plain', operational: { primary } } as const;
      const status = readSessionAwarenessWorkStatusV1({ awareness });
      expect(readSessionAwarenessPresentationV1(awareness)).toBe(primary === 'working' ? 'thinking' : primary === 'none' ? 'unknown' : primary);
      expect(status).toEqual(primary === 'working' ? { bucket: 'working', tone: 'neutral' }
        : primary === 'failed' ? { bucket: 'needs_you', tone: 'danger' }
          : primary === 'permission_required' || primary === 'action_required' ? { bucket: 'needs_you', tone: 'attention' }
            : { bucket: 'idle', tone: 'neutral' });
      expect(readSessionAwarenessWorkStatusV1({ awareness: { ...awareness, freshness: 'stale' } }))
        .toEqual({ bucket: 'idle', tone: 'neutral' });
    }
    for (const reason of ['runtime_unservable', 'resuming'] as const) {
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'unknown', encryption: 'ready',
        operational: { primary: 'permission_required', reasons: [reason] } } }))
        .toEqual({ bucket: reason === 'runtime_unservable' ? 'offline' : 'idle', tone: 'neutral' });
    }
  });

  it('preserves live actionable facts and quiet settlement', () => {
    for (const primary of ['failed', 'permission_required', 'action_required'] as const) {
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'waiting', encryption: 'ready',
        operational: { primary } } })).toEqual({ bucket: 'needs_you', tone: primary === 'failed' ? 'danger' : 'attention' });
    }
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'idle', encryption: 'plain',
      operational: { primary: 'ready' } }, settled: true })).toEqual({ bucket: 'finished', tone: 'neutral' });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', lifecycle: 'archived',
      encryption: 'locked', operational: { primary: 'failed' } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', encryption: 'plain',
      operational: { primary: 'working', reasons: ['resuming'] } } })).toEqual({ bucket: 'idle', tone: 'neutral' });
  });
});
