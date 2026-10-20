import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { areStoredSessionsEqual } from '@/sync/store/domains/areStoredSessionsEqual';
import { buildUpdatedSessionProjectionFromSocketUpdate } from './syncSessions';
import { parseCompatSessionByIdResponse } from './sessionHttpCompat';

function baseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 2,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 2,
        ...overrides,
    } as Session;
}

describe('responsibility projection through the normalized Session corridor', () => {
    it('keeps an unsupported projection distinguishable from an explicit "nobody"', () => {
        const unsupported = baseSession();
        const unassigned = baseSession({ responsibleAccountId: null });
        const assigned = baseSession({ responsibleAccountId: 'account-1' });

        expect(unsupported.responsibleAccountId).toBeUndefined();
        expect(areStoredSessionsEqual(unsupported, unassigned)).toBe(false);
        expect(areStoredSessionsEqual(unassigned, assigned)).toBe(false);
        expect(areStoredSessionsEqual(assigned, baseSession({ responsibleAccountId: 'account-1' }))).toBe(true);
    });

    it('applies only complete socket responsibility tuples and refetches malformed patches', () => {
        const assigned = baseSession({
            responsibleAccountId: 'account-1',
            responsibleAccount: {
                kind: 'account',
                accountId: 'account-1',
                name: 'Alice',
                firstName: 'Alice',
                lastName: null,
                username: 'alice',
                avatarUrl: null,
            },
        });
        const silent = buildUpdatedSessionProjectionFromSocketUpdate({
            session: assigned,
            updateBody: { active: true },
            updateSeq: 5,
            updateCreatedAt: 10,
        });
        expect(silent.responsibleAccountId).toBe('account-1');

        const onResponsibilityResyncRequired = vi.fn();
        const cleared = buildUpdatedSessionProjectionFromSocketUpdate({
            session: assigned,
            updateBody: { responsibleAccountId: null, responsibleAccount: null },
            updateSeq: 6,
            updateCreatedAt: 11,
            onResponsibilityResyncRequired,
        });
        expect(cleared.responsibleAccountId).toBeNull();

        const reassigned = buildUpdatedSessionProjectionFromSocketUpdate({
            session: assigned,
            updateBody: { responsibleAccountId: 'account-2', responsibleAccount: {
                kind: 'account', accountId: 'account-2', firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null,
            } },
            updateSeq: 7,
            updateCreatedAt: 12,
            onResponsibilityResyncRequired,
        });
        expect(reassigned.responsibleAccountId).toBe('account-2');
        expect(reassigned.responsibleAccount?.accountId).toBe('account-2');

        for (const updateBody of [
            { responsibleAccountId: 'account-2' },
            { responsibleAccount: assigned.responsibleAccount },
            { responsibleAccountId: null, responsibleAccount: assigned.responsibleAccount },
            { responsibleAccountId: 'account-2', responsibleAccount: assigned.responsibleAccount },
        ]) {
            const malformed = buildUpdatedSessionProjectionFromSocketUpdate({
                session: assigned, updateBody, updateSeq: 8, updateCreatedAt: 13, onResponsibilityResyncRequired,
            });
            expect(malformed.responsibleAccountId).toBe('account-1');
            expect(malformed.responsibleAccount).toEqual(assigned.responsibleAccount);
        }
        expect(onResponsibilityResyncRequired).toHaveBeenCalledTimes(4);
    });

    it('preserves omitted, null and assigned values through the by-id compatibility parser', () => {
        const record = {
            id: 'session-1',
            seq: 4,
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 2,
            metadata: '{}',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            dataEncryptionKey: null,
        };

        const omitted = parseCompatSessionByIdResponse({ session: { ...record } });
        expect(omitted).not.toBeNull();
        expect('responsibleAccountId' in (omitted!.session as Record<string, unknown>)).toBe(false);

        const unassigned = parseCompatSessionByIdResponse({
            session: { ...record, responsibleAccountId: null, responsibleAccount: null },
        });
        expect(unassigned!.session.responsibleAccountId).toBeNull();

        const assigned = parseCompatSessionByIdResponse({
            session: { ...record, responsibleAccountId: 'account-1', responsibleAccount: {
                kind: 'account', accountId: 'account-1', firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null,
            } },
        });
        expect(assigned!.session.responsibleAccountId).toBe('account-1');

        for (const responsibility of [
            { responsibleAccountId: 'account-1' },
            { responsibleAccount: null },
            { responsibleAccountId: null, responsibleAccount: assigned!.session.responsibleAccount },
            { responsibleAccountId: 'account-2', responsibleAccount: assigned!.session.responsibleAccount },
        ]) {
            expect(parseCompatSessionByIdResponse({ session: { ...record, ...responsibility } })).toBeNull();
        }
    });
});
