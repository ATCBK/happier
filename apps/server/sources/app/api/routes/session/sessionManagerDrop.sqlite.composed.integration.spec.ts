import * as z from 'zod/mini';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, SessionManagerOptionsV1Schema, SessionManagerSetResultV1Schema,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeSessionOwnerMetadataEnvelopeV1, SessionSharedMetadataV1Schema } from '@happier-dev/protocol';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { EntityDropOutcomeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { sessionRoutes } from './sessionRoutes';
import { createEntityDragDropRuntime } from '../../../../../../ui/sources/components/ui/treeDragDrop/entityDragDropRuntime';
import { resolveSessionListEntityDrop } from '../../../../../../ui/sources/components/sessions/shell/drag/resolveSessionListEntityDrop';
import { buildSessionListDragIntent } from '../../../../../../ui/sources/components/sessions/shell/drag/sessionListDragIntent';
import { treeRowId } from '../../../../../../ui/sources/components/sessions/shell/drop-resolution/treeRowId';
import { computeVisibleSessionListIndex } from '../../../../../../ui/sources/sync/domains/session/listing/computeVisibleSessionListIndex';
import { resolvePutUnderEligibility } from '../../../../../../ui/sources/components/sessions/work/putUnderCandidates';
import { createSessionManagerEligibilitySnapshot } from '../../../../../../ui/sources/sync/ops/relations/sessionManagerEligibility';
import { createSessionFixture } from '../../../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { createActionExecutorBoundaryFixture } from '../../../../../../ui/sources/dev/testkit/fixtures/actionExecutorBoundary';
import { projectActionOutcome } from '../../../../../../ui/sources/components/sessions/shell/dropPreview/sessionListActionOutcome';
import type { SessionListIndexItem } from '../../../../../../ui/sources/sync/domains/sessionList/sessionListIndex';

// Locale/platform lookup is an environment boundary; all drop, Action, route and DB logic is real.
vi.mock('../../../../../../ui/sources/text', async () => {
    const { createTextModuleMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('non-folder manager drop through Action and SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reports-drop-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('persists and projects a cross-group child under its lead; missing Action binding cannot do so', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const create = () => db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: JSON.stringify(SessionSharedMetadataV1Schema.parse({ v: 1 })),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1({ t: 'plain', v: { v: 1 } }) } });
        const [child, lead] = await Promise.all([create(), create()]);
        const app = createAuthenticatedTestApp();
        sessionRoutes(app);
        await app.ready();
        const scope = { serverId: 'home', accountId: owner.id };
        const headers = { 'x-test-user-id': owner.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/sessions/${child.id}/manager/options`, headers,
                payload: { candidateSessionIds: [lead.id] } });
            expect(response.statusCode).toBe(200);
            const facts = createSessionManagerEligibilitySnapshot({ ...SessionManagerOptionsV1Schema.parse(response.json()),
                ...scope, isCurrent: () => true, dispose: () => {} });
            const rows = { [child.id]: createSessionFixture({ id: child.id, serverId: scope.serverId }),
                [lead.id]: createSessionFixture({ id: lead.id, serverId: scope.serverId }) };
            const items: SessionListIndexItem[] = [
                { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'today' },
                { type: 'session', sessionId: lead.id, serverId: scope.serverId, storageKind: 'persisted', groupKey: 'today', groupKind: 'date' },
                { type: 'header', title: 'Yesterday', headerKind: 'date', groupKey: 'yesterday' },
                { type: 'session', sessionId: child.id, serverId: scope.serverId, storageKind: 'persisted', groupKey: 'yesterday', groupKind: 'date' },
            ];
            const sourceRowId = treeRowId.session(scope.serverId, child.id);
            const targetRowId = treeRowId.session(scope.serverId, lead.id);
            const intent = buildSessionListDragIntent({ sourceRowId, sourceKind: 'leaf', snapshotSignature: '', result: {
                instruction: { kind: 'nest-into', targetId: targetRowId, containerId: targetRowId, parentId: targetRowId, depth: 1 },
                visual: { kind: 'outline', targetId: targetRowId },
            } });
            const context = { scope, latestItems: items, sessionFoldersV1: { v: 1 as const, folders: [] },
                sessionListGroupOrderV1: {}, now: () => Date.now(), isFolderOrganizationEnabled: () => false,
                resolvePutSessionUnder: (input: { sessionId: string; managerSessionId: string }) =>
                    resolvePutUnderEligibility(rows, input.sessionId, input.managerSessionId, facts, scope),
                setSessionFoldersV1: async () => { throw new Error('No folder write'); },
                setSessionListGroupOrderV1: async () => { throw new Error('No order write'); },
                setSessionFolderAssignment: async () => { throw new Error('No folder assignment'); },
            };
            const bound = createActionExecutorBoundaryFixture({ sessionManagerSet: async request => {
                const mutation = await app.inject({ method: 'POST', url: `/v1/sessions/${request.sessionId}/manager`, headers,
                    payload: { managerSessionId: request.managerSessionId, expectedManagerSessionId: request.expectedManagerSessionId } });
                expect(mutation.statusCode).toBe(200);
                return SessionManagerSetResultV1Schema.parse(mutation.json());
            } });
            const drop = async (wired: boolean) => {
                const executor = createActionExecutor(wired ? bound : createActionExecutorBoundaryFixture({}));
                const runtime = createEntityDragDropRuntime();
                runtime.registerSource({ id: 'child', scope, isCurrent: () => true,
                    getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId: child.id } }) });
                runtime.registerTarget({ id: 'list', scope, acceptedKinds: ['session'],
                    getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
                    resolve: ({ item }) => resolveSessionListEntityDrop({ item, intent, context,
                        preview: () => ({ glyph: 'nest', verb: 'Put under Lead', target: 'Lead' }), reason: code => ({ code, message: code }) }),
                    execute: async effect => {
                        if (effect.actionId !== 'session.manager.set') throw new Error('Unexpected drop Action');
                        return EntityDropOutcomeV1Schema.parse(projectActionOutcome(effect.actionId,
                            await executor.execute(effect.actionId, effect.input,
                                { surface: 'ui_button', authority: 'present_user', serverId: scope.serverId, bypassApprovals: true })));
                    },
                });
                const carry = runtime.begin('child')!;
                carry.move({ x: 100, y: 100 });
                expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { actionId: 'session.manager.set' } });
                return carry.release();
            };
            expect(await drop(false)).toMatchObject({ status: 'unknown' });
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
            expect(await drop(true)).toEqual({ status: 'applied' });
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toMatchObject({ destinationSessionId: lead.id, relation: 'manager' });
            const list = await app.inject({ method: 'GET', url: '/v2/sessions?limit=10', headers });
            expect(list.statusCode).toBe(200);
            const projected = z.array(V2SessionRecordSchema).parse(list.json().sessions);
            const childProjection = projected.find(row => row.id === child.id)!;
            expect(childProjection.manager).toEqual({ sessionId: lead.id });
            rows[child.id] = { ...rows[child.id]!, manager: childProjection.manager };
            const visible = computeVisibleSessionListIndex({ source: items,
                resolveSessionRow: (_home, id) => rows[id] ?? null, hideInactiveSessions: false,
                pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, presentation: { enabled: false, presentation: 'grouped' } })!;
            expect(visible.filter(row => row.type === 'session').map(row => [row.sessionId, row.groupKey, row.reportsDepth ?? 0]))
                .toEqual([[lead.id, 'today', 0], [child.id, 'today', 1]]);
            expect(visible.filter(row => row.type === 'header').map(row => row.groupKey)).toEqual(['today']);
        } finally { await app.close(); }
    });
});
