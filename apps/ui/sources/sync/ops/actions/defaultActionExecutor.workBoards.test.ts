import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent,
    createWorkBoardV1, buildWorkBoardItemKeyV1, WorkBoardV1Schema } from '@happier-dev/protocol';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from '@/components/boards/model/workBoardAccountStore';
import { createWorkBoardUiActionPort } from '@/components/boards/model/workBoardEntityDrop';
import { projectBoardMembership } from '@/components/boards/model/boardMembership';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';

// Only HTTP, credentials and native UI modules are replaced; domain and encryption owners run.
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    await connection?.dispose(); connection = null;
    retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests(); getStorage().setState(initialState, true); vi.restoreAllMocks();
});
const writeSchema = z.object({ header: z.string(), body: z.string(), expectedBodyVersion: z.number(), expectedHeaderVersion: z.number() });

describe('Board Actions through captured Home Artifacts', () => {
    it('rebases a Board conflict on the captured Home and deletes through the Artifact revision owner', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://board-target.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://board-focused.test', scope: 'tab' });
        const token = createAccountTokenForTests('board-owner');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const first = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: target.id, id: 's1' } });
        const second = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: target.id, id: 's2' } });
        let board = createWorkBoardV1({ id: 'mine', name: 'My Board' });
        let version = 1;
        let conflict = true;
        let deleted = false;
        const requests: string[] = [];
        const row = () => ({ id: board.id,
            header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', v: 1, title: board.name, pinnedInSessions: board.pinnedInSessions, readsNeedsYou: false }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }),
            headerVersion: version, bodyVersion: version, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            seq: version, createdAt: 1, updatedAt: version, ownerAccountId: 'board-owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' });
        const request: Parameters<typeof setRuntimeFetch>[0] = async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://board-target.test');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            const method = init?.method ?? 'GET';
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
            requests.push(`${method} ${url.pathname}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { unrelated: 'x'.repeat(600_000) } }, version: 1 });
            if (url.pathname === '/v1/artifacts') return Response.json(deleted ? [] : [row()]);
            if (url.pathname === '/v1/artifacts/mine/access/grants' && method === 'GET') return deleted
                ? Response.json({ error: 'artifact_not_found' }, { status: 404 })
                : Response.json(ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: board.id,
                    ownerAccountId: 'board-owner', access: 'owner', grants: [] }));
            if (url.pathname === '/v1/artifacts/mine' && method === 'GET') return deleted ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(row());
            if (url.pathname === '/v1/artifacts/mine' && method === 'POST') {
                const write = writeSchema.parse(JSON.parse(String(init?.body)));
                expect(write.expectedBodyVersion).toBe(version);
                if (conflict) {
                    conflict = false; version++;
                    board = { ...board, positionsByItemRef: { [second]: { x: 3, y: 4 } } };
                    return Response.json({ success: false, error: 'version-mismatch' });
                }
                const opened = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(write.body));
                board = WorkBoardV1Schema.parse(JSON.parse(opened.body)); version++;
                return Response.json({ success: true, headerVersion: version, bodyVersion: version });
            }
            if (url.pathname === `/v1/artifacts/mine/revision/${version}/${version}` && method === 'DELETE') {
                deleted = true; return Response.json({ success: true });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        setRuntimeFetch(request);
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, surface: 'ui', bypassApprovals: true } as const;
        const firstApply = await executor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'mine', positionsByItemRef: { [first]: { x: 48, y: 96 } } } }, context);
        expect(firstApply, JSON.stringify(firstApply))
            .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [first]: { x: 48, y: 96 }, [second]: { x: 3, y: 4 } } } } });
        // The mounted UI queue is the trusted live-membership port, not a second writer.
        // Account capture, Action schema/policy and execution all stay real above the Artifact boundary.
        const uiBoard = { ...board, source: { picked: [{ kind: 'session' as const, qualifiedId: { serverId: target.id, id: 's1' } }] } };
        const uiPersistence = createWorkBoardArtifactBoundary({ v: 1, boards: [uiBoard] });
        const uiStore = createWorkBoardAccountStore(uiPersistence.transport, () => true);
        const uiPort = createWorkBoardUiActionPort(() => ({ scope: { serverId: target.id, accountId: 'board-owner' }, board: uiBoard,
            membership: projectBoardMembership(uiBoard, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }), uiStore.queue, uiStore.readBoardAccess);
        const uiExecutor = createDefaultActionExecutor({ workBoardArtifacts: uiPort });
        expect(await uiExecutor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'mine',
            positionsByItemRef: { [first]: { x: 72, y: 120 } } } }, { ...context, expectedAccountId: 'board-owner' }))
            .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [first]: { x: 72, y: 120 } } } } });
        expect(uiPersistence.acknowledged().boards[0]!.positionsByItemRef).toEqual({ [first]: { x: 72, y: 120 } });
        expect(board.positionsByItemRef[first]).toEqual({ x: 48, y: 96 });
        // Widget catalog admission requires this Home's genuine mounted Account;
        // the preceding Board writes still prove captured, non-focused Home routing.
        connection = await restoreServerAccountForTest({ serverUrl: target.serverUrl, accountId: 'board-owner', credentials: { token }, request });
        setRuntimeFetch(request);
        const surface = { serverId: target.id, accountId: 'board-owner', owner: { kind: 'workBoard', boardId: 'mine' } } as const;
        const instance = { v: 1, id: 'configured', definition: { kind: 'inline', definition: { v: 1, id: 'checks', name: 'Checks',
            sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } }, provenance: { source: { kind: 'authored' } } } }, bindings: {} } satisfies import('@happier-dev/protocol/widgets').WidgetInstanceV1;
        const widgetResult = await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'mine', ref: { surface, instanceId: instance.id }, instance } }, context);
        expect(widgetResult, JSON.stringify(widgetResult)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [{ instance, size: 'medium' }] } });
        expect(await executor.execute('widgets.item.size.set', { ref: { surface, instanceId: instance.id }, size: 'full' }, context)).toMatchObject({ ok: true });
        expect(board.widgets?.[0]?.size).toBe('full');
        expect(await executor.execute('widgets.item.remove', { ref: { surface, instanceId: instance.id } }, context)).toMatchObject({ ok: true });
        expect(board.widgets).toEqual([]);
        expect(await executor.execute('boards.list', {}, context)).toMatchObject({ ok: true, result: { boards: [{ id: 'mine' }] } });
        expect(await executor.execute('boards.apply', { intent: { kind: 'delete', boardId: 'mine' } }, context)).toMatchObject({ ok: true });
        expect(deleted).toBe(true);
        expect(requests).not.toContain('POST /v2/account/settings');
    });
});
