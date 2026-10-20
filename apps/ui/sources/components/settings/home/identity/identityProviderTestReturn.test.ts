import { describe, expect, it } from 'vitest';

import {
    consumeIdentityProviderTestReturn,
    consumePendingIdentityProviderTest,
    recordIdentityProviderTestReturn,
    recordPendingIdentityProviderTest,
    resetPendingIdentityProviderTestsForTests,
    runTeamIdentityProviderTestReturn,
} from './identityProviderTestReturn';
import { peekPendingAdministrationOAuth } from '@/sync/domains/pending/pendingAdministrationOAuth';

const diagnostics = {
    subjectPresent: true,
    loginAvailable: true,
    emailAvailable: false,
    emailVerified: false,
    groups: { state: 'absent' as const, count: null },
    eligibility: { status: 'eligible' as const, rules: [] },
    mappedGroups: [],
};

describe('identityProviderTestReturn', () => {
    it('hands the pending test to the durable administration custody the return document reads', () => {
        resetPendingIdentityProviderTestsForTests();
        recordPendingIdentityProviderTest({
            kind: 'home',
            serverId: 'home-a',
            accountId: 'account-1',
            providerId: 'provider-1',
            attemptId: 'attempt-1',
            returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
        });

        // On web the authorize URL opens a new `noopener` document, so module state is gone by
        // the time `/oauth/<provider>` consumes this. It has to reach the durable owner.
        expect(peekPendingAdministrationOAuth()).toEqual({
            kind: 'identity_provider_test',
            test: {
                kind: 'home',
                serverId: 'home-a',
                accountId: 'account-1',
                providerId: 'provider-1',
                attemptId: 'attempt-1',
                returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
            },
        });
        expect(consumePendingIdentityProviderTest('provider-1')).not.toBeNull();
        expect(peekPendingAdministrationOAuth()).toBeNull();
    });

    it('keeps exact Home and provider custody and consumes it once', () => {
        resetPendingIdentityProviderTestsForTests();
        recordPendingIdentityProviderTest({
            kind: 'home',
            serverId: 'home-a',
            accountId: 'account-1',
            providerId: 'provider-1',
            attemptId: 'attempt-1',
            returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
        });

        expect(consumePendingIdentityProviderTest('other')).toBeNull();
        expect(consumePendingIdentityProviderTest('provider-1')).toEqual({
            kind: 'home',
            serverId: 'home-a',
            accountId: 'account-1',
            providerId: 'provider-1',
            attemptId: 'attempt-1',
            returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
        });
        expect(consumePendingIdentityProviderTest('provider-1')).toBeNull();
    });

    it('hands the completed Home test to the exact Home, Account, and provider exactly once', () => {
        resetPendingIdentityProviderTestsForTests();
        const pending = {
            kind: 'home' as const,
            serverId: 'home-a',
            accountId: 'account-1',
            providerId: 'provider-1',
            attemptId: 'attempt-1',
            returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
        };
        recordIdentityProviderTestReturn(pending, { kind: 'completed', diagnostics });

        expect(consumeIdentityProviderTestReturn({
            serverId: 'home-a', accountId: 'account-1', providerId: 'provider-2',
        })).toBeNull();
        expect(consumeIdentityProviderTestReturn({
            serverId: 'home-a', accountId: 'account-1', providerId: 'provider-1',
        })).toEqual({
            kind: 'completed',
            attemptId: 'attempt-1',
            diagnostics,
        });
        expect(consumeIdentityProviderTestReturn({
            serverId: 'home-a', accountId: 'account-1', providerId: 'provider-1',
        })).toBeNull();
    });

    it('fails closed and retires a Home test handoff when its Account scope does not match', () => {
        resetPendingIdentityProviderTestsForTests();
        const pending = {
            kind: 'home' as const,
            serverId: 'home-a',
            accountId: 'account-1',
            providerId: 'provider-1',
            attemptId: 'attempt-1',
            returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
        };
        recordIdentityProviderTestReturn(pending, { kind: 'completed', diagnostics });

        expect(consumeIdentityProviderTestReturn({
            serverId: 'home-a', accountId: 'account-2', providerId: 'provider-1',
        })).toBeNull();
        expect(consumeIdentityProviderTestReturn({
            serverId: 'home-a', accountId: 'account-1', providerId: 'provider-1',
        })).toBeNull();
    });

    it('carries only the exact Action descriptor needed for the destination approval shell', () => {
        resetPendingIdentityProviderTestsForTests();
        const pending = {
            kind: 'home' as const,
            serverId: 'home-a',
            accountId: 'account-1',
            providerId: 'provider-1',
            attemptId: 'attempt-1',
            returnTo: '/settings/home/home-a/sign-in-providers/identity/provider-1',
        };
        recordIdentityProviderTestReturn(pending, {
            kind: 'approval_pending',
            artifactId: 'approval-1',
            actionId: 'identity.providers.test.consume',
            scope: { serverId: 'home-a', accountId: 'account-1' },
        });

        expect(consumeIdentityProviderTestReturn({
            serverId: 'home-a', accountId: 'account-1', providerId: 'provider-1',
        })).toEqual({
            kind: 'approval_pending',
            attemptId: 'attempt-1',
            artifactId: 'approval-1',
            actionId: 'identity.providers.test.consume',
            scope: { serverId: 'home-a', accountId: 'account-1' },
        });
    });

    it('consumes a Team callback at the exact route target without relying on the OAuth screen', async () => {
        const consume = async (input: Readonly<{ teamId: string | null; connectionId: string; resultHandle: string }>) => ({
            ok: true as const,
            input,
        });

        await expect(runTeamIdentityProviderTestReturn({
            purpose: 'identity_connection_test',
            resultHandle: 'result-1',
            error: null,
            teamId: 'team-1',
            connectionId: 'connection-1',
            consume,
        })).resolves.toEqual({ kind: 'consumed', diagnostics: null });

        await expect(runTeamIdentityProviderTestReturn({
            purpose: 'identity_connection_test',
            resultHandle: null,
            error: 'invalid_state',
            teamId: 'team-1',
            connectionId: 'connection-1',
            consume,
        })).resolves.toEqual({ kind: 'failed', code: 'invalid_state' });

        await expect(runTeamIdentityProviderTestReturn({
            purpose: 'identity_connection_test',
            resultHandle: 'result-2',
            error: null,
            teamId: 'team-1',
            connectionId: 'connection-1',
            consume: async () => ({ ok: true as const, value: { diagnostics } }),
        })).resolves.toEqual({ kind: 'consumed', diagnostics });

        await expect(runTeamIdentityProviderTestReturn({
            purpose: 'identity_connection_test',
            resultHandle: 'result-3',
            error: null,
            teamId: 'team-1',
            connectionId: 'connection-1',
            consume: async () => ({
                ok: false as const,
                approvalPending: true as const,
                artifactId: 'approval-1',
                failure: { code: 'approval_pending' },
            }),
        })).resolves.toEqual({ kind: 'approval_pending', artifactId: 'approval-1' });
    });
});
