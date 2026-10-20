import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionFollowSourceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { createSessionCoordinatorRestoreInput, deriveSessionCoordinatorControls, planSessionCoordinatorRuleRemoval } from './sessionCoordinatorFollowControls';

const address = { serverId: 'home', sessionId: 'worker' };
const definition = { v: 1 as const, enabled: false,
    filter: normalizeSessionListFilterV1({ scope: 'all_accessible' }), policy: { preset: 'quiet' as const } };
const own = { ruleId: 'own', receiver: { kind: 'session' as const, sessionId: 'worker' }, definition, version: 3 };
const snapshot = { coverage: 'complete', follows: [], rules: [own,
    { ...own, ruleId: 'other', receiver: { kind: 'session', sessionId: 'other' } },
    { ...own, ruleId: 'personal', receiver: { kind: 'account' } },
], sources: [SessionFollowSourceV1Schema.parse({ sourceSessionId: 'ordinary', destinationSessionId: 'worker', policy: { preset: 'quiet' },
    deliveryState: 'eligible', hasPendingUpdates: false })] };

describe('coordinator rule removal plan', () => {
    it('selects only this Session rule snapshots without changing the definition', () => {
        expect(planSessionCoordinatorRuleRemoval(address, snapshot))
            .toEqual({ status: 'ready', coverage: 'complete', rules: [own] });
    });
    it.each(['partial', 'unavailable'])('preserves %s coverage instead of manufacturing an empty success', coverage => {
        expect(planSessionCoordinatorRuleRemoval(address, { ...snapshot, rules: [], coverage }))
            .toEqual({ status: 'unavailable', coverage });
    });
    it('restores the exact saved definition and policy with the removal-returned CAS version', () => {
        expect(createSessionCoordinatorRestoreInput({ previous: own, expectedVersion: 4 })).toEqual({
            receiver: own.receiver, source: { kind: 'rule', ruleId: own.ruleId },
            ruleDefinition: { v: 1, enabled: false, filter: definition.filter },
            policy: definition.policy, expectedVersion: 4,
        });
    });
});

describe('nonvisual coordinator controls', () => {
    it('disables Make but not Stop for a proven rule coordinator and exposes canonical navigation intents', () => {
        const controls = deriveSessionCoordinatorControls({ address, managedSessions: { total: 0 },
            receivedRuleCount: 1, receivedRuleCoverage: 'complete' });
        expect(controls.make).toBe('disabled');
        expect(controls.stop).toBe('enabled');
        expect(controls.edit).toEqual({ kind: 'session_following', address, tab: 'collaboration', direction: 'following' });
        expect(controls.openAsBoard.filter).toEqual(normalizeSessionListFilterV1({
            scope: 'all_accessible', show: 'both', homeServerIds: ['home'], underSessionId: 'worker',
        }));
    });
    it('does not enable Stop for a manager-only coordinator', () => {
        expect(deriveSessionCoordinatorControls({ address, managedSessions: { total: 2 },
            receivedRuleCount: 0, receivedRuleCoverage: 'complete' })).toMatchObject({ make: 'disabled', stop: 'disabled' });
    });
    it('keeps unknown evidence unavailable rather than interpreting it as zero', () => {
        expect(deriveSessionCoordinatorControls({ address, receivedRuleCoverage: 'unavailable' }))
            .toMatchObject({ make: 'unavailable', stop: 'unavailable' });
        expect(deriveSessionCoordinatorControls({ address, managedSessions: { total: 0 }, receivedRuleCount: 0,
            receivedRuleCoverage: 'partial' })).toMatchObject({ make: 'unavailable', stop: 'unavailable' });
    });
    it('permits Make only once both coordinator facts are known absent', () => {
        expect(deriveSessionCoordinatorControls({ address, managedSessions: { total: 0 },
            receivedRuleCount: 0, receivedRuleCoverage: 'complete' })).toMatchObject({ make: 'enabled', stop: 'disabled' });
    });
});
