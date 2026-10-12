import { describe, expect, it } from 'vitest';

import { resolveSessionGuardComposerState } from './resolveSessionGuardComposerState';
import { resolveSessionViewConnectionStatus } from './resolveSessionViewConnectionStatus';

const status = {
    connectedServicesRestartState: null, restartingText: 'restarting', switchFailedText: 'failed', inactiveStatusText: 'Inactive (resumable)',
    sessionStatusResuming: false, sessionStatusState: 'ready', sessionStatusText: 'ready', sessionStatusColor: 'ink', sessionStatusDotColor: 'dot',
    sessionStatusPulsing: false,
} as const;
const inks = { attentionColor: 'amber', quietColor: 'quiet' };

describe('the composer while the guard stops a session (plan 50 G3)', () => {
    it('counts down to a coming stop with Keep running, and stops counting once the warning ran out', () => {
        const warning = resolveSessionGuardComposerState({ guard: { kind: 'stopping', stopAt: 10_000, rule: 'idle_sessions' }, sessionActive: true, resuming: false, nowMs: 1_000 });
        expect(warning).toEqual({ kind: 'warning', text: 'Stopping in', countdownTo: 10_000, action: 'keep_running' });
        expect(resolveSessionViewConnectionStatus({ ...status, guard: { state: warning, ...inks } }))
            .toEqual({ text: 'Stopping in', color: 'amber', dotColor: 'amber', isPulsing: false, countdownTo: 10_000, guardAction: 'keep_running', transitionKey: 'warning' });
        expect(resolveSessionGuardComposerState({ guard: { kind: 'stopping', stopAt: 10_000, rule: 'idle_sessions' }, sessionActive: true, resuming: false, nowMs: 10_000 })).toBeNull();
    });

    it('says a stopped session wakes on the next message, and that it is waking once one is sent', () => {
        const stopped = resolveSessionGuardComposerState({ guard: { kind: 'stopped', at: 5, rule: 'idle_sessions', freedBytes: 1 }, sessionActive: false, resuming: false, nowMs: 9 });
        expect(stopped).toEqual({ kind: 'stopped', text: 'Stopped to free memory · your next message wakes it', placeholder: 'Message to wake this session…' });
        // The guard's word replaces the generic inactive line.
        expect(resolveSessionViewConnectionStatus({ ...status, guard: { state: stopped, ...inks } })).toMatchObject({ text: 'Stopped to free memory · your next message wakes it', dotColor: 'quiet' });
        expect(resolveSessionGuardComposerState({ guard: { kind: 'stopped', at: 5, rule: 'ceiling' }, sessionActive: false, resuming: false, nowMs: 9 }))
            .toMatchObject({ text: 'Stopped at its memory ceiling · your next message wakes it' });
        expect(resolveSessionGuardComposerState({ guard: { kind: 'stopped', at: 5, rule: 'memory_guard' }, sessionActive: false, resuming: true, nowMs: 9 }))
            .toEqual({ kind: 'waking', text: 'Waking · picks up where it stopped' });
        // Working again, the ordinary status speaks.
        expect(resolveSessionGuardComposerState({ guard: { kind: 'stopped', at: 5, rule: 'memory_guard' }, sessionActive: true, resuming: false, nowMs: 9 })).toBeNull();
    });

    it('leaves a connected-service restart as the more urgent fact', () => {
        const warning = resolveSessionGuardComposerState({ guard: { kind: 'stopping', stopAt: 10_000, rule: 'idle_sessions' }, sessionActive: true, resuming: false, nowMs: 1 });
        expect(resolveSessionViewConnectionStatus({ ...status, guard: { state: warning, ...inks },
            connectedServicesRestartState: { status: 'restarting', attemptId: 'a', reason: 'manual_auth_switch', startedAtMs: 1 } })).toMatchObject({ text: 'restarting' });
    });
});
