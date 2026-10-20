import { describe, expect, it } from 'vitest';

import { resolveDevelopmentStartUnavailableReason } from './developmentStartAvailability';

describe('resolveDevelopmentStartUnavailableReason', () => {
    it('says once why the development start tiles are unavailable, and stays quiet when a notice already says it', () => {
        // Live 2026-10-16 (PLUGVIS r2k/r2l): all three tiles were disabled with no reason while the
        // selected machine had not answered its current read (the retained list was still shown).
        const base = { noTarget: false, notice: null, daemonOperationsAvailable: true, createAvailable: true, sourceInstallAvailable: true } as const;
        expect(resolveDevelopmentStartUnavailableReason(base)).toBeNull();
        expect(resolveDevelopmentStartUnavailableReason({ ...base, noTarget: true, daemonOperationsAvailable: false })).toBeNull();
        expect(resolveDevelopmentStartUnavailableReason({ ...base, daemonOperationsAvailable: false, notice: { reason: 'refreshing' } })).toBe('waitingForMachine');
        expect(resolveDevelopmentStartUnavailableReason({ ...base, daemonOperationsAvailable: false })).toBe('waitingForMachine');
        // A failed or offline read already has its banner: one message per state.
        expect(resolveDevelopmentStartUnavailableReason({ ...base, daemonOperationsAvailable: false, notice: { reason: 'disconnected' } })).toBeNull();
        // Answered, but this machine does not offer development.
        expect(resolveDevelopmentStartUnavailableReason({ ...base, createAvailable: false, sourceInstallAvailable: false })).toBe('notOffered');
        expect(resolveDevelopmentStartUnavailableReason({ ...base, createAvailable: false })).toBeNull();
    });
});
