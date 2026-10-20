import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionFollowSourceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { RemoveSessionFollowRuleRequestV1Schema, SetSessionFollowRuleRequestV1Schema,
    type SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';

const transport = vi.hoisted(() => vi.fn());
// The Session RPC is a network boundary; the coordinator Action and its child admission remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: { sessionRpcWithServerScope: transport } });
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const { storage } = await import('@/sync/domains/state/storageStore');
const { sessionCoordinatorActions } = await import('./sessionCoordinatorActions');
const previous = storage.getState();
let home: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; storage.setState(previous); transport.mockReset(); });

async function setup(options: { unavailableRules?: boolean; wrongRestoreRow?: boolean } = {}) {
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ scope: 'all_accessible' }),
        policy: { preset: 'important' as const } };
    const rule = (ruleId: string, sessionId: string): SessionFollowRuleV1 => ({ ruleId,
        receiver: { kind: 'session', sessionId }, version: 3, content: { t: 'plain', v: definition } });
    // Only the HTTP server is replaced. Real Follow schemas, encryption, admission and UI front door stay active.
    const rules = new Map([['own-rule', rule('own-rule', 'worker')], ['other-rule', rule('other-rule', 'other')]]);
    const tombstones = new Map<string, number>();
    const failures = new Set<string>();
    home = await serveSessionActionHome({ homes: [
        { key: 'selected', serverUrl: 'https://coordinator-selected.test', accountId: 'account', currentAccount: true },
        { key: 'focused', serverUrl: 'https://coordinator-focused.test', accountId: 'account', currentAccount: true },
    ], route: ({ home: target, path, method, body }) => {
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
            sessions: { following: { enabled: true } },
        } }));
        if (target !== 'selected') return undefined;
        if (path === '/v2/sessions/worker/follows/sessions') return Response.json({ sources: [SessionFollowSourceV1Schema.parse({
            sourceSessionId: 'ordinary-source', destinationSessionId: 'worker', policy: { preset: 'quiet' },
            deliveryState: 'eligible', hasPendingUpdates: false,
        })] });
        if (path === '/v2/account/session-follow-rules') return options.unavailableRules
            ? Response.json({ error: 'unavailable' }, { status: 503 })
            : Response.json({ rules: [...rules.values()] });
        const match = /^\/v2\/account\/session-follow-rules\/([^/]+)$/u.exec(path);
        if (!match) return undefined;
        const ruleId = decodeURIComponent(match[1]!);
        const current = rules.get(ruleId);
        if (method === 'DELETE') {
            const request = RemoveSessionFollowRuleRequestV1Schema.parse(body);
            if (failures.has(ruleId)) return Response.json({ error: 'version_conflict' }, { status: 409 });
            if (!current || request.expectedVersion !== current.version) return Response.json({ error: 'version_conflict' }, { status: 409 });
            rules.delete(ruleId);
            tombstones.set(ruleId, current.version + 1);
            return Response.json({ changed: true, version: current.version + 1 });
        }
        if (method === 'PUT') {
            const request = SetSessionFollowRuleRequestV1Schema.parse(body);
            if (request.expectedVersion !== (current?.version ?? tombstones.get(ruleId) ?? -1)) {
                return Response.json({ error: 'version_conflict' }, { status: 409 });
            }
            const restored = { ruleId, receiver: request.receiver, version: request.expectedVersion + 1, content: request.content };
            rules.set(ruleId, restored);
            return Response.json({ rule: options.wrongRestoreRow ? { ...restored, ruleId: 'unrelated-rule' } : restored });
        }
        return undefined;
    } });
    const address = { serverId: home.homes.selected!.id, sessionId: 'worker' };
    storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: home.homes.focused!.id }) } });
    return { address, rules, tombstones, failures, definition };
}

describe('coordinator controls through the UI Action front door', () => {
    it('enables through real coordinator admission and keeps the role effect at the selected Home', async () => {
        const env = await setup();
        transport.mockImplementation(async ({ serverId, sessionId, method }) => {
            expect({ serverId, sessionId, method }).toEqual({ serverId: env.address.serverId,
                sessionId: 'worker', method: 'session.role.set' });
            return { updated: true };
        });
        expect(await sessionCoordinatorActions.enable('worker', { roleId: 'orchestrator', keep: 'none', ruleSuggestions: [] },
            { serverId: env.address.serverId })).toMatchObject({ ok: true, result: { sessionId: 'worker',
            status: 'configured', effects: [{ operation: 'role', status: 'accepted' }] } });
    });
    it('stops only the selected Session rule follows, preserving ordinary follows and other Sessions', async () => {
        const env = await setup();
        await sessionCoordinatorActions.stop('worker', { serverId: env.address.serverId });
        expect(env.rules.has('own-rule')).toBe(false);
        expect(env.rules.has('other-rule')).toBe(true);
        expect(home!.requests.filter(request => request.method === 'DELETE').map(request => [request.home, request.path]))
            .toEqual([['selected', '/v2/account/session-follow-rules/own-rule']]);
    });
    it('undo restores the removed snapshot using the deletion version, not the old live version', async () => {
        const env = await setup();
        const stopped = await sessionCoordinatorActions.stop('worker', { serverId: env.address.serverId });
        expect(stopped.status).toBe('stopped');
        const restored = await sessionCoordinatorActions.undoStop(stopped.undo);
        expect(restored.status).toBe('restored');
        expect(env.rules.get('own-rule')).toMatchObject({ version: 5, content: { t: 'plain', v: env.definition } });
    });
    it('stale undo preserves a later edit instead of replacing it', async () => {
        const env = await setup();
        const stopped = await sessionCoordinatorActions.stop('worker', { serverId: env.address.serverId });
        const later = { ruleId: 'own-rule', receiver: { kind: 'session' as const, sessionId: 'worker' },
            version: 5, content: { t: 'plain' as const, v: { ...env.definition, enabled: false } } };
        env.rules.set('own-rule', later);
        const restored = await sessionCoordinatorActions.undoStop(stopped.undo);
        expect(restored.status).toBe('partial');
        expect(restored.failures).toMatchObject([{ ruleId: 'own-rule' }]);
        expect(env.rules.get('own-rule')).toEqual(later);
    });
    it('does not acknowledge a schema-valid restore response for another rule', async () => {
        const env = await setup({ wrongRestoreRow: true });
        const stopped = await sessionCoordinatorActions.stop('worker', { serverId: env.address.serverId });
        const restored = await sessionCoordinatorActions.undoStop(stopped.undo);
        expect(restored).toMatchObject({ status: 'partial', restoredRuleIds: [],
            failures: [{ ruleId: 'own-rule' }] });
    });
    it('does not remove anything when the rule census is unavailable', async () => {
        const env = await setup({ unavailableRules: true });
        const stopped = await sessionCoordinatorActions.stop('worker', { serverId: env.address.serverId });
        expect(stopped.status).toBe('unavailable');
        expect(stopped.coverage).not.toBe('complete');
        expect(env.rules.has('own-rule')).toBe(true);
        expect(home!.requests.filter(request => request.method === 'DELETE')).toEqual([]);
    });
    it('keeps Undo limited to successful removals after a partial Stop', async () => {
        const env = await setup();
        env.rules.set('conflict-rule', { ...env.rules.get('own-rule')!, ruleId: 'conflict-rule' });
        env.failures.add('conflict-rule');
        const stopped = await sessionCoordinatorActions.stop('worker', { serverId: env.address.serverId });
        expect(stopped.status).toBe('partial');
        expect(stopped.undo.removed.map(item => item.previous.ruleId)).toEqual(['own-rule']);
        expect(env.rules.has('conflict-rule')).toBe(true);
        await sessionCoordinatorActions.undoStop(stopped.undo);
        expect(env.rules.has('own-rule')).toBe(true);
        expect(home!.requests.filter(request => request.method === 'PUT').map(request => request.path))
            .toEqual(['/v2/account/session-follow-rules/own-rule']);
    });
    it('refuses an ambiguous bare Session before any request or effect', async () => {
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: 'home-a' }) },
            ordinarySessionListMembershipByServerId: { 'home-a': ['worker'], 'home-b': ['worker'] } });
        expect(await sessionCoordinatorActions.enable('worker', { roleId: 'orchestrator', keep: 'none', ruleSuggestions: [] }))
            .toMatchObject({ ok: false, errorCode: 'session_not_selected' });
        expect(await sessionCoordinatorActions.stop('worker')).toMatchObject({ status: 'unavailable',
            coverage: 'unavailable', undo: { removed: [] }, errorCode: 'session_not_selected' });
        expect(transport).not.toHaveBeenCalled();
    });
});
