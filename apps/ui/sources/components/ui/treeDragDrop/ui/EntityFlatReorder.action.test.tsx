import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { z } from 'zod/mini';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import type { EntityFlatReorderBinding } from './EntityFlatReorder';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { TodoList } = await import('@/components/zen/lists/TodoList');
const { EntityFlatReorderList } = await import('./EntityFlatReorder');
const { storage } = await import('@/sync/domains/state/storage');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = undefined; });

describe('flat-list production Action completion', () => {
    it.each(['reject', 'approve'] as const)('holds a persisted Ask-first Todo move until %s settles the same invocation', async decision => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Reorder', serverUrl: 'https://reorder.test', accountId: 'alice' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://reorder.test', accountId: 'alice', request: homes.request });
        await homes.requireUiApproval(serverId, 'tasks.internal.reorder');
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const todos = ['one', 'two'].map(id => ({ id, title: id, done: false, createdAt: 1, updatedAt: 1 }));
        storage.getState().applyTodos({ todos: Object.fromEntries(todos.map(todo => [todo.id, todo])), undoneOrder: ['one', 'two'], doneOrder: [], versions: {} });
        for (const todo of todos) homes.answer(serverId, `/v1/kv/todo.${todo.id}`, { body: { key: `todo.${todo.id}`, version: 1,
            value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }) } });
        homes.answer(serverId, '/v1/kv/todo.index', { body: { key: 'todo.index', version: 1,
            value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { undoneOrder: ['one', 'two'], completedOrder: [] } }) } });
        let writes = 0;
        homes.answer(serverId, 'POST /v1/kv', { select: input => {
            const { mutations } = z.object({ mutations: z.array(z.object({ key: z.string(), value: z.string(), version: z.number() })) }).parse(input);
            writes++;
            return { body: { success: true, results: mutations.map(row => ({ key: row.key, version: row.version + 1 })) } };
        } });
        const screen = await renderScreen(<TodoList todos={todos} />);
        try {
            const binding: EntityFlatReorderBinding = screen.findByType(EntityFlatReorderList).props.binding;
            const admission = binding.resolve('one', { anchorId: 'two', placement: 'after' });
            expect(admission.status).toBe('allowed');
            if (admission.status !== 'allowed') throw new Error('Move was not admitted');
            let settled = false;
            const pending = binding.execute(admission.effect).then(result => { settled = true; return result; });
            const artifact = await waitForHomeGovernance(() => {
                const artifact = homes.artifacts(serverId).list()[0];
                expect(artifact).toBeDefined();
                return artifact!;
            });
            const request = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id) ?? 'null'));
            expect(request).toMatchObject({ status: 'open', actionId: 'tasks.internal.reorder', actionArgs: admission.effect.input });
            expect(settled).toBe(false);
            expect(writes).toBe(0);
            await act(async () => {
                expect(await decideApprovalAsInbox(serverId, artifact.id, decision)).toMatchObject({ ok: true });
            });
            await waitForHomeGovernance(() => expect(settled).toBe(true));
            const result = await pending;
            expect(result, JSON.stringify(result)).toMatchObject(decision === 'reject' ? { status: 'refused' } : { status: 'applied' });
            expect(writes).toBe(decision === 'approve' ? 1 : 0);
            expect(storage.getState().todoState?.undoneOrder).toEqual(decision === 'approve' ? ['two', 'one'] : ['one', 'two']);
        } finally { await screen.unmount(); }
    });
});
