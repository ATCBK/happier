import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor, getActionSpec, normalizeActionsSettingsV1,
    type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { blockPendingDelivery, enqueuePendingMessage } from './pendingMessageService';

async function importCliModule<T>(specifier: string): Promise<T> {
    // Consume the production CLI graph without widening the server compiler root.
    return await import(specifier) as T;
}

const { runWithServerHttpBaseUrl } = await importCliModule<{
    runWithServerHttpBaseUrl: <T>(url: string, run: () => Promise<T>) => Promise<T>;
}>('../../../../../cli/src/api/client/serverHttpBaseUrl');
const { createCliActionDeps } = await importCliModule<{
    createCliActionDeps: (options: unknown) => ActionExecutorDeps;
}>('../../../../../cli/src/session/actions/createCliActionDeps');
const { createCliApprovalsArtifactStore } = await importCliModule<{
    createCliApprovalsArtifactStore: (options: unknown) => Pick<ActionExecutorDeps,
        'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate'>;
}>('../../../../../cli/src/session/actions/approvals/artifactStore');
const { createCliActionExecutorFromCredentials } = await importCliModule<{
    createCliActionExecutorFromCredentials: (options: unknown) => {
        execute: ReturnType<typeof createActionExecutor>['execute'];
        resolveSessionTarget: (id: string) => Promise<{ ok: true; sessionId: string }>;
    };
}>('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
const { listCompiledActionCliCommands } = await importCliModule<{
    listCompiledActionCliCommands: () => readonly { actionId: string; path: readonly string[] }[];
}>('../../../../../cli/src/cli/actions/compiledCommands');
const { runCompiledActionCliCommand } = await importCliModule<{
    runCompiledActionCliCommand: (options: unknown) => Promise<void>;
}>('../../../../../cli/src/cli/actions/executeCommand');
const { createActionSettingsProvider } = await importCliModule<{
    createActionSettingsProvider: () => unknown;
}>('../../../../../cli/src/settings/actionsSettingsProvider');
const { captureConsoleJsonOutput } = await importCliModule<{
    captureConsoleJsonOutput: () => { json: () => unknown; restore: () => void };
}>('../../../../../cli/src/testkit/logger/captureOutput');

const recoveryActions = ['session.pending.markHandled', 'session.pending.dismiss', 'session.pending.sendAsNew'] as const;

describe('Pending recovery Actions through registered CLI wiring, HTTP and SQLite', () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let origin: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-pending-recovery-actions-',
            initAuth: true, initEncrypt: true, initFiles: true });
        app = createAuthenticatedTestApp({ authentication: 'real' });
        sessionPendingRoutes(app);
        registerAccountEncryptionRoutes(app);
        artifactsRoutes(app);
        origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);

    afterAll(async () => {
        try { await app?.close(); } finally { await harness?.close(); }
    });

    it('withdraws queued input from an archived Session through the CLI Action', async () => {
        harness.resetEnv();
        const machineKey = new Uint8Array(32).fill(8);
        const encryption = { type: 'dataKey' as const, machineKey,
            publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey };
        const owner = await db.account.create({ data: createSignedAccountContentBinding(encryption.publicKey) });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
        const localId = randomUUID();
        expect(await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId,
            authentication: createPresentUserSessionAccessAuthentication(), ciphertext: 'queued-protected-input',
            requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ ok: true });
        await db.session.update({ where: { id: session.id }, data: { active: false, archivedAt: new Date() } });

        await runWithServerHttpBaseUrl(origin, async () => {
            const credentials = { token, encryption };
            const store = createCliApprovalsArtifactStore({ credentials, serverId: origin });
            const deps = createCliActionDeps({ token, credentials, sessionId: session.id,
                serverId: origin, serverHttpBaseUrl: origin });
            const executor = createActionExecutor({ ...deps, ...store });
            const input = { sessionId: session.id, localId, serverId: origin };
            const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation',
                serverId: origin, runtimeAccountId: owner.id, actionRequestId: randomUUID(), actionCaller: { kind: 'host' } };
            const command = listCompiledActionCliCommands().find(row => row.actionId === 'session.pending.withdraw');
            if (!command) throw new Error('Expected generated withdrawal command');
            const previousExitCode = process.exitCode;
            const output = captureConsoleJsonOutput();
            try {
                await runCompiledActionCliCommand({ command,
                    argv: [...command.path, '--input-json', JSON.stringify(input), '--json'],
                    deps: { readCredentialsFn: async () => credentials,
                        createExecutorFn: (options: Readonly<Record<string, unknown>>) => createCliActionExecutorFromCredentials({ ...options,
                            serverIdentityId: 'srv_pending_withdrawal', actionsSettingsProvider: createActionSettingsProvider(),
                        }) },
                });
                expect(output.json()).toMatchObject({ ok: true, data: { kind: 'approval_request_created' } });
            } finally { output.restore(); process.exitCode = previousExitCode; }
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
            const result = await executor.execute('session.pending.withdraw', input, { ...context,
                actionsSettings: normalizeActionsSettingsV1({ v: 1,
                    approvalWaivedSurfaces: { 'session.pending.withdraw': ['cli'] } }) });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { outcome: 'removed' } });
            if (!result.ok) throw new Error('Expected queued withdrawal');
            getActionSpec('session.pending.withdraw').outputSchema!.parse(result.result);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingCount: true } }))
                .toEqual({ pendingCount: 0 });
        });
    });

    it.each(recoveryActions)('requires approval and preserves the owning recovery transition (%s)', async actionId => {
        harness.resetEnv();
        const machineKey = new Uint8Array(32).fill(7);
        const encryption = { type: 'dataKey' as const, machineKey,
            publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey };
        const owner = await db.account.create({ data: createSignedAccountContentBinding(encryption.publicKey) });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
        const localId = `historical-${randomUUID()}`;
        const request = { actorUserId: owner.id, sessionId: session.id, localId,
            authentication: createPresentUserSessionAccessAuthentication() };
        expect(await enqueuePendingMessage({ ...request, ciphertext: 'original-protected-input',
            requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true });
        expect(await blockPendingDelivery({ ...request, reason: 'delivery_outcome_uncertain' }))
            .toMatchObject({ ok: true, didUpdate: true });
        const original = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
        });
        if (actionId === 'session.pending.markHandled') {
            // A previous producer wrote the user row but exited before sealing its
            // acceptance. This existing shape cannot be recovered by Withdraw.
            await db.session.update({ where: { id: session.id }, data: { seq: 1 } });
            await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1,
                messageRole: 'user', content: original.content,
                inputAdmissionReceipt: original.inputAdmissionReceipt ?? undefined } });
        }

        const readPendingState = async () => {
            const [state, rows, messages] = await Promise.all([
                db.session.findUniqueOrThrow({ where: { id: session.id },
                    select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true } }),
                db.sessionPendingMessage.findMany({ where: { sessionId: session.id }, orderBy: { position: 'asc' } }),
                db.sessionMessage.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } }),
            ]);
            return { state, rows, messages };
        };

        await runWithServerHttpBaseUrl(origin, async () => {
            const credentials = { token, encryption };
            const store = createCliApprovalsArtifactStore({ credentials, serverId: origin });
            // The catalog/executor and every Pending HTTP adapter are production
            // implementations; only unused transports are left unbound.
            const deps = createCliActionDeps({ token, credentials, sessionId: session.id,
                serverId: origin, serverHttpBaseUrl: origin });
            const executor = createActionExecutor({ ...deps, ...store });
            const input = { sessionId: session.id, localId, serverId: origin };
            const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation',
                serverId: origin, runtimeAccountId: owner.id, actionRequestId: randomUUID(), actionCaller: { kind: 'host' } };
            const before = await readPendingState();
            const proposed = await executor.execute(actionId, input, context);
            expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object'
                || !('artifactId' in proposed.result) || typeof proposed.result.artifactId !== 'string') {
                throw new Error('Expected default Ask-first recovery approval');
            }
            expect(await readPendingState()).toEqual(before);
            const artifactId = proposed.result.artifactId;
            expect(await store.approvalsGet!({ artifactId, serverId: origin }))
                .toMatchObject({ actionId, status: 'open' });
            const rejected = await executor.execute('approval.request.decide', { artifactId, decision: 'reject' },
                { surface: 'ui', authority: 'present_user', serverId: origin, runtimeAccountId: owner.id });
            expect(rejected, JSON.stringify(rejected)).toMatchObject({ ok: true, result: { status: 'rejected' } });
            if (!rejected.ok) throw new Error('Expected persisted rejection');
            getActionSpec('approval.request.decide').outputSchema!.parse(rejected.result);
            expect(await store.approvalsGet!({ artifactId, serverId: origin })).toMatchObject({ status: 'rejected' });
            expect(await readPendingState()).toEqual(before);

            const disabled = await executor.execute(actionId, input, { ...context,
                actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }) });
            expect(disabled).toMatchObject({ ok: false, errorCode: 'action_disabled' });
            expect(await readPendingState()).toEqual(before);

            // A user's configured waiver is evaluated by the same policy owner.
            const allowed: ActionExecutorContext = { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
                approvalWaivedSurfaces: { [actionId]: ['cli'], 'session.pending.withdraw': ['cli'] } }) };
            const withdrawn = await executor.execute('session.pending.withdraw', input, allowed);
            expect(withdrawn, JSON.stringify(withdrawn)).toMatchObject({ ok: true, result: { outcome: 'delivery_unknown' } });
            if (!withdrawn.ok) throw new Error('Expected uncertain Withdraw outcome');
            getActionSpec('session.pending.withdraw').outputSchema!.parse(withdrawn.result);
            expect(await readPendingState()).toEqual(before);

            if (actionId === 'session.pending.markHandled') {
                // Wiring sensitivity: losing the production binding cannot settle
                // the historical row, even when policy allows the operation.
                const missing = createActionExecutor({ ...deps, ...store, sessionPendingMarkHandled: undefined });
                expect(await missing.execute(actionId, input, allowed))
                    .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                expect(await readPendingState()).toEqual(before);
            }

            const recovered = await executor.execute(actionId, input, allowed);
            expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true });
            if (!recovered.ok) throw new Error('Expected allowed recovery');
            const output = getActionSpec(actionId).outputSchema!.parse(recovered.result);
            if (actionId === 'session.pending.sendAsNew') {
                expect(output).toEqual({ newLocalId: expect.any(String) });
                if (!output || typeof output !== 'object' || !('newLocalId' in output) || typeof output.newLocalId !== 'string') {
                    throw new Error('Expected replacement identity');
                }
                expect(output.newLocalId).not.toBe(localId);
                const settled = await readPendingState();
                expect(settled.state).toMatchObject({ pendingCount: 1, pendingBlockedCount: 0 });
                expect(settled.messages).toEqual([]);
                expect(settled.rows).toHaveLength(2);
                expect(settled.rows.find(row => row.localId === localId))
                    .toMatchObject({ status: 'discarded', discardedReason: 'resent_as_new', content: original.content });
                expect(settled.rows.find(row => row.localId === output.newLocalId)).toMatchObject({
                    status: 'queued', deliveryState: null, content: original.content, authorAccountId: original.authorAccountId,
                    inputAdmissionReceipt: original.inputAdmissionReceipt, requestedAction: { v: 1, kind: 'enqueue' },
                });
                const repeated = await executor.execute(actionId, input, allowed);
                expect(repeated).toMatchObject({ ok: true, result: output });
                if (!repeated.ok) throw new Error('Expected idempotent replacement');
                getActionSpec(actionId).outputSchema!.parse(repeated.result);
                expect(await readPendingState()).toEqual(settled);
            } else {
                expect(output).toEqual({ ok: true });
                const settled = await readPendingState();
                expect(settled.state).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
                if (actionId === 'session.pending.markHandled') {
                    expect(settled.rows).toEqual([]);
                    expect(settled.messages).toHaveLength(1);
                    expect(settled.messages[0]).toMatchObject({ localId, seq: 1 });
                    expect(await executor.execute('session.pending.withdraw', input, allowed))
                        .toMatchObject({ ok: true, result: { outcome: 'already_delivered' } });
                } else {
                    expect(settled.messages).toEqual([]);
                    expect(settled.rows).toHaveLength(1);
                    expect(settled.rows[0]).toMatchObject({ localId, status: 'discarded',
                        discardedReason: 'dismissed_uncertain', content: original.content });
                }
                const repeated = await executor.execute(actionId, input, allowed);
                expect(repeated).toMatchObject({ ok: true, result: { ok: true } });
                if (!repeated.ok) throw new Error('Expected idempotent recovery');
                getActionSpec(actionId).outputSchema!.parse(repeated.result);
                expect(await readPendingState()).toEqual(settled);
            }
        });
    });
});
