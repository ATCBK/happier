import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';

import { applySessionListRenderablePatch, areSessionListRenderablesEqual, buildSessionListRenderableFromSession } from './sessionListRenderable';
import { buildSessionFromListRenderable } from './sessionListRenderableSessionProjection';
import { buildSessionListRowFilterFacts } from './sessionListWorkFilter';
import { matchSessionListFilterV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { areStoredSessionsEqual } from '@/sync/store/domains/areStoredSessionsEqual';

describe('locked shared title projection', () => {
    const title = 'Previously authorized shared title';
    const locked = createSessionFixture({
        serverId: 'home-a', metadataLayoutVersion: 1, encryptionMode: 'e2ee',
        encryptedContentAvailability: 'encrypted_access_needs_repair',
        metadata: null, ownerMetadataView: null,
        access: createSessionAccessFixture('view'), accessLevel: 'view',
        lockedDisplayTitle: title,
    });

    it('carries only the trusted title through a cold locked projection and reconstruction', () => {
        const cold = buildSessionListRenderableFromSession(locked);
        expect(getSessionName(cold)).toBe(title);
        expect(cold.metadata).toBeNull();
        const reconstructed = buildSessionFromListRenderable(cold, { serverId: 'home-a' });
        expect(getSessionName(reconstructed)).toBe(title);
        expect(reconstructed.metadata).toBeNull();
        expect(reconstructed.ownerMetadataView).toBeNull();
    });

    it('does not copy previous metadata while carrying a trusted warm locked title', () => {
        const cold = buildSessionListRenderableFromSession(locked);
        const warm = buildSessionListRenderableFromSession(locked, {
            ...cold,
            metadata: { summaryText: 'Old title', path: '/private/owner', host: 'owner.local' },
        });
        expect(getSessionName(warm)).toBe(title);
        expect(warm.metadata).toBeNull();
    });

    it('does not revive a retired title from the previous row after a Home change', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        const cleared = buildSessionListRenderableFromSession({
            ...locked, serverId: 'home-b', lockedDisplayTitle: null,
        }, previous);
        expect(getSessionName(cleared)).not.toBe(title);
        expect(cleared.metadata).toBeNull();
        expect(getSessionName(buildSessionFromListRenderable(cleared, {
            baseSession: locked, serverId: 'home-b',
        }))).not.toBe(title);
    });

    it('clears the retained title when shared content becomes readable without a title', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        const readable = buildSessionListRenderableFromSession({
            ...locked, encryptedContentAvailability: 'ready',
            metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
        }, previous);
        expect(getSessionName(readable)).not.toBe(title);
        expect(getSessionName(buildSessionFromListRenderable(readable, { baseSession: locked }))).not.toBe(title);
    });

    it('clears the retained title when access no longer identifies a recipient', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        for (const access of [createSessionAccessFixture('owner'), null]) {
            const cleared = buildSessionListRenderableFromSession({ ...locked, access, accessLevel: undefined }, previous);
            expect(getSessionName(cleared)).not.toBe(title);
            expect(getSessionName(buildSessionFromListRenderable(cleared, { baseSession: locked }))).not.toBe(title);
        }
    });

    it('observes title-only changes and retirement in the canonical row comparison', () => {
        const row = buildSessionListRenderableFromSession(locked);
        const previous = { ...row, lockedDisplayTitle: title };
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: 'Changed title' })).toBe(false);
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: null })).toBe(false);
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: title })).toBe(true);
    });

    it('clears the memory title when a list patch changes content or recipient access', () => {
        const row = { ...buildSessionListRenderableFromSession(locked), lockedDisplayTitle: title };
        const readable = applySessionListRenderablePatch(row, { metadata: { path: '', summaryText: null } });
        expect(readable).toHaveProperty('lockedDisplayTitle', null);
        const retired = applySessionListRenderablePatch(row, { access: null, accessLevel: undefined });
        expect(getSessionName(retired)).not.toBe(title);
    });
});

describe('buildSessionFromListRenderable', () => {
    it('carries rule membership through cold row projection, filter facts and reconstruction without guessing missing counts', () => {
        const session = createSessionFixture({ ownerAccountId: 'owner', origin: { kind: 'none' },
            managedSessions: { total: 0, working: 0, needsYou: 0, stalled: 0 }, receivedRuleCount: 1 });
        const row = buildSessionListRenderableFromSession(session);
        expect(row.receivedRuleCount).toBe(1);
        expect(buildSessionFromListRenderable(row).receivedRuleCount).toBe(1);
        const facts = buildSessionListRowFilterFacts(row, 'home', { nowMs: 1, viewerAccountId: 'owner' });
        expect(facts).toMatchObject({ receivedRuleCount: 1, managedSessions: { total: 0 } });
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible', coordinator: 'coordinator' });
        const match = (candidate: typeof row) => matchSessionListFilterV1(filter,
            buildSessionListRowFilterFacts(candidate, 'home', { nowMs: 1, viewerAccountId: 'owner' }));
        expect(match(row)).toBe('match');
        const noRules = buildSessionListRenderableFromSession({ ...session, receivedRuleCount: 0 }, row);
        expect(areSessionListRenderablesEqual(row, noRules)).toBe(false);
        expect(areStoredSessionsEqual(session, { ...session, receivedRuleCount: 0 })).toBe(false);
        expect(match(noRules)).toBe('miss');
        const unknown = buildSessionListRenderableFromSession({ ...session, receivedRuleCount: undefined }, row);
        expect(buildSessionFromListRenderable(unknown, { baseSession: session }).receivedRuleCount).toBeUndefined();
        expect(match(unknown)).toBe('unavailable');
    });
    it('retains the protected owner Account and invalidates stale starter projections', () => {
        const session = createSessionFixture({ ownerAccountId: 'owner', origin: { kind: 'none' } });
        const row = buildSessionListRenderableFromSession(session);
        expect(row.ownerAccountId).toBe('owner');
        expect(buildSessionFromListRenderable(row).ownerAccountId).toBe('owner');
        expect(areSessionListRenderablesEqual(row, { ...row, ownerAccountId: 'other' })).toBe(false);
    });
    it('uses independently current metadata for work facts when an opened report has older metadata', () => {
        const metadata = (title: string) => ({ path: '/repo', host: 'test', sessionWorkStateV1: {
            v: 1 as const, backendId: 'claude', updatedAt: 1_000_000,
            items: [{ id: 'task', kind: 'task' as const, origin: 'happier' as const, title,
                status: 'active' as const, updatedAt: 1_000_000 }],
        } });
        const base = createSessionFixture({ seq: 20, metadataVersion: 1, active: true, activeAt: 1_000_000,
            metadata: { ...metadata('Earlier work'), work: { memoryEnabled: true } } });
        const row = buildSessionListRenderableFromSession({ ...base, seq: 19, metadataVersion: 2, metadata: metadata('Current work') });
        expect(getSessionStatus(row, 1_000_000).awareness.currentWork?.title).toBe('Current work');
        const current = buildSessionFromListRenderable(row, { baseSession: base });
        expect(getSessionStatus(current, 1_000_000).awareness.currentWork)
            .toEqual(getSessionStatus(row, 1_000_000).awareness.currentWork);
        expect(current.metadata?.work).toEqual(base.metadata?.work);
        expect(current.metadataVersion).toBe(2);
        const newerBase = { ...base, metadataVersion: 3, metadata: metadata('Newest work') };
        const retained = buildSessionFromListRenderable(row, { baseSession: newerBase });
        expect(getSessionStatus(retained, 1_000_000).awareness.currentWork)
            .toEqual(getSessionStatus(newerBase, 1_000_000).awareness.currentWork);
        expect(retained.metadataVersion).toBe(3);
    });
    it('keeps the public Agent and owner view on the selected layout-v1 metadata tuple', () => {
        const base = createSessionFixture({ metadataLayoutVersion: 1, metadataVersion: 3,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1),
            ownerMetadataView: { path: '/newer', host: 'machine', work: { memoryEnabled: true } } });
        const row = buildSessionListRenderableFromSession({ ...base, metadataVersion: 2,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
            ownerMetadataView: { path: '/older', host: 'machine' } });
        const retained = buildSessionFromListRenderable(row, { baseSession: base });
        expect(readSessionPresentationAgentId(retained)).toBe('codex');
        expect(readSessionOwnerMetadataView(retained)).toEqual(base.ownerMetadataView);
        expect(retained.metadataVersion).toBe(3);
    });
    it('merges independently ordered turn facts instead of reviving an older in-progress state', () => {
        const base = createSessionFixture({ id: 'report', seq: 10, active: true, latestTurnStatus: 'completed', latestTurnStatusObservedAt: 30 });
        const row = buildSessionListRenderableFromSession({ ...base, seq: 11, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 20 });
        const report = buildSessionFromListRenderable(row, { baseSession: base });
        expect(report.seq).toBe(11);
        expect(report.latestTurnStatus).toBe('completed');
    });
    it('keeps the list work facts when a layout-v1 report has not been opened', () => {
        const nowMs = 1_000_000;
        const source = createSessionFixture({ metadataLayoutVersion: 1, active: true, activeAt: nowMs,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
            ownerMetadataView: { path: '/repo', host: 'test', sessionWorkStateV1: { v: 1, backendId: 'claude', updatedAt: nowMs,
                items: [{ id: 'task', kind: 'task', origin: 'happier', title: 'Payments rollout', status: 'blocked', updatedAt: nowMs }] } } });
        const row = buildSessionListRenderableFromSession(source);
        const report = buildSessionFromListRenderable(row);
        expect(getSessionStatus(row, nowMs).awareness.currentWork).toBeDefined();
        expect(getSessionStatus(report, nowMs).awareness.currentWork).toEqual(getSessionStatus(row, nowMs).awareness.currentWork);
    });
    it('keeps the declared public Agent identity when an unopened layout-v1 report is reconstructed', () => {
        const source = createSessionFixture({ metadataLayoutVersion: 1,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'claude' } }, 1),
            ownerMetadataView: { path: '/repo', host: 'test', flavor: 'codex' } });
        const row = buildSessionListRenderableFromSession(source);
        const report = buildSessionFromListRenderable(row);
        expect(readSessionPresentationAgentId(report)).toBe('claude');
        expect(readSessionOwnerMetadataView(report)?.path).toBe('/repo');
        const { flavor: _previousAgentId, ...withoutAgent } = row.metadata!;
        const changed = buildSessionFromListRenderable({ ...row, metadata: withoutAgent,
            seq: row.seq + 1, metadataVersion: row.metadataVersion + 1 }, { baseSession: report });
        expect(readSessionPresentationAgentId(changed)).toBeNull();
        const unreadable = buildSessionFromListRenderable({ ...row, metadata: null, metadataUnavailable: true });
        expect(readSessionPresentationAgentId(unreadable)).toBeNull();
        const warmUnreadable = buildSessionFromListRenderable({ ...row, metadata: null, metadataUnavailable: true }, { baseSession: source });
        expect(warmUnreadable.metadata).toBeNull();
        expect(warmUnreadable.ownerMetadataView).toBeNull();
    });
    it('preserves an explicit detached list edge rather than reviving the opened session lead', () => {
        const base = createSessionFixture({ manager: { sessionId: 'former-lead' } });
        const detached = buildSessionListRenderableFromSession({ ...base, manager: null });
        expect(buildSessionFromListRenderable(detached, { baseSession: base }).manager).toBeNull();
        expect(buildSessionFromListRenderable({ ...detached, manager: undefined }, { baseSession: base }).manager)
            .toEqual({ sessionId: 'former-lead' });
    });
    it('keeps legacy row metadata readable without reviving an unavailable layout-v1 owner view', () => {
        const legacy = createSessionFixture({
            metadata: {
                path: '/home/alice/project',
                host: 'workstation',
                machineId: 'machine-a',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const row = buildSessionListRenderableFromSession(legacy);
        const reconstructed = buildSessionFromListRenderable(row);
        expect(readSessionOwnerMetadataView(reconstructed)).toMatchObject({
            path: '/home/alice/project',
            machineId: 'machine-a',
            hiddenSystemSession: true,
        });

        const unavailable = buildSessionFromListRenderable({
            ...row,
            metadataLayoutVersion: 1,
            metadataUnavailable: true,
        });
        expect(readSessionOwnerMetadataView(unavailable)).toBeNull();
        expect(readSessionOwnerMetadataView(buildSessionFromListRenderable({
            ...row,
            metadataUnavailable: true,
        }))).toBeNull();
        const contracted = buildSessionFromListRenderable({ ...row, metadataLayoutVersion: 1, metadata: null,
            metadataVersion: 0, metadataUnavailable: true, access: createSessionAccessFixture('view'), accessLevel: 'view' },
        { baseSession: legacy });
        expect(contracted.metadata).toBeNull();
        expect(contracted.ownerMetadataView).toBeNull();
    });

    it('preserves the safe responsible Account summary through list renderable reconstruction', () => {
        const responsibleAccount = {
            kind: 'account' as const,
            accountId: 'account-alice',
            name: 'Alice',
            firstName: 'Alice',
            lastName: null,
            username: 'alice',
            avatarUrl: null,
        };
        const source = createSessionFixture({
            id: 'assigned-session',
            responsibleAccountId: responsibleAccount.accountId,
            responsibleAccount,
        });

        const renderable = buildSessionListRenderableFromSession(source);
        expect(renderable.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(renderable.responsibleAccount).toEqual(responsibleAccount);

        const reconstructed = buildSessionFromListRenderable(renderable);
        expect(reconstructed.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(reconstructed.responsibleAccount).toEqual(responsibleAccount);
    });

    it('keeps omitted and explicit-null responsibility summaries distinct', () => {
        const omitted = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unsupported-session',
        }));
        const unassigned = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unassigned-session',
            responsibleAccountId: null,
            responsibleAccount: null,
        }));

        expect('responsibleAccount' in omitted).toBe(false);
        expect(unassigned.responsibleAccount).toBeNull();
        expect('responsibleAccount' in buildSessionFromListRenderable(omitted)).toBe(false);
        expect(buildSessionFromListRenderable(unassigned).responsibleAccount).toBeNull();
    });

    it('reconstructs a layout-v1 owner metadata view without exposing it to recipients', () => {
        const ownerMetadata = {
            path: '/home/alice/project',
            homeDir: '/home/alice',
            host: 'workstation',
            machineId: 'machine-a',
        };
        const renderable = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'layout-v1-owner',
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: ownerMetadata,
            access: {
                role: 'owner',
                level: 'owner',
                capabilities: projectLegacySessionAccessCapabilitiesV1({
                    level: 'owner',
                    canApprovePermissions: true,
                }),
            },
        }));

        const ownerSession = buildSessionFromListRenderable(renderable);
        expect(ownerSession.metadataLayoutVersion).toBe(1);
        expect(readSessionOwnerMetadataView(ownerSession)).toMatchObject(ownerMetadata);

        const recipientSession = buildSessionFromListRenderable({
            ...renderable,
            access: {
                role: 'recipient',
                level: 'view',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            },
            accessLevel: 'view',
        });
        expect(recipientSession.metadataLayoutVersion).toBe(1);
        expect(recipientSession.ownerMetadataView).toBeNull();
        expect(readSessionOwnerMetadataView(recipientSession)).toBeNull();
    });
});
