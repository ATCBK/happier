import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { PluginAccountStorageMutationRequestV1Schema, PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import * as accountChanges from '@/api/observeAccountChanges';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

afterEach(() => vi.restoreAllMocks());

it.each([
    { scenario: 'approve', surface: 'cli' },
    { scenario: 'approve', surface: 'agent' },
    { scenario: 'approve', surface: 'mcp' },
    { scenario: 'reject', surface: 'cli' },
    { scenario: 'disable', surface: 'cli' },
    { scenario: 'uncertain', surface: 'cli' },
] as const)(
    'keeps the public authored Account write pending until a separate CLI decides: $surface $scenario', async ({ scenario, surface }) => {
        const app = fastify();
        const endpoint = 'http://account-approval.test';
        const serverId = 'account-approval';
        const accountId = 'account-owner';
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const features = registerAccountHomeHttp(app, { accountId, serverId });
        const { pluginId, artifacts, setEnabled } = await registerAuthoredAccountActionRelease(app, accountId);
        let approvalArtifactId: string | undefined;
        const readApproval = () => {
            if (!approvalArtifactId) throw new Error('Missing approval Artifact');
            const value = decodePlainArtifactStoredContent(artifacts.read(approvalArtifactId)!.body);
            if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string') throw new Error('Missing approval body');
            return StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(value.body));
        };
        let stored: ReturnType<typeof PluginAccountStorageReadResponseV1Schema.parse> = { status: 'absent' };
        let writes = 0;
        app.get(`/v1/account/plugin-storage/${pluginId}`, async () => stored);
        app.post(`/v1/account/plugin-storage/${pluginId}`, async (request, reply) => {
            const mutation = PluginAccountStorageMutationRequestV1Schema.parse(request.body);
            expect(readApproval().status).toBe('executing');
            expect(mutation.expectedRevision).toBe('absent');
            if (!mutation.content) throw new Error('Expected a public fixture write');
            writes++;
            stored = PluginAccountStorageReadResponseV1Schema.parse({ status: 'present', revision: 1, content: mutation.content });
            // The Home may commit and lose its acknowledgement. This must not
            // turn a second approval decision into another write attempt.
            if (scenario === 'uncertain') return reply.code(503).send({ error: 'acknowledgement_lost' });
            return PluginAccountStorageMutationResponseV1Schema.parse({ status: 'updated', revision: 1 });
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
        let publishArtifactId: (id: string) => void = () => {};
        const approvalCreated = new Promise<string>(resolve => { publishArtifactId = resolve; });
        // Account change observation is the external socket adapter. The real
        // Artifact reader, decision writer, approval coordinator and invocation
        // policy remain bound by the normal CLI composition.
        vi.spyOn(accountChanges, 'observeAccountChanges').mockImplementation((options) => {
            if (options.entityId) { approvalArtifactId = options.entityId; publishArtifactId(options.entityId); }
            return { dispose: async () => {} };
        });
        const controller = new AbortController();
        const original = createCliActionExecutorFromCredentials({ credentials, serverId, serverIdentityId: serverId,
            serverApiUrl: endpoint });
        let settled = false;
        const invoking = original.execute('action.invoke', { action: { pluginId, localId: 'write' },
            input: { key: 'approved', value: 'written once' } }, { surface, signal: controller.signal,
            runtimeAccountId: accountId, serverId, serverIdentityId: serverId }).then(result => { settled = true; return result; });
        try {
            const artifactId = await Promise.race([approvalCreated, invoking.then(result => {
                throw new Error(`Account write settled before approval: ${JSON.stringify(result)}`);
            })]);
            expect(settled).toBe(false);
            expect(writes).toBe(0);
            expect(readApproval()).toMatchObject({ status: 'open', approvalInputCustody: 'live_only',
                qualifiedActionId: `${pluginId}/actions/write` });
            if (scenario === 'disable') setEnabled(false);
            // This standalone public executor gets no plugin registry, replay
            // override, current-intent callback, Machine or shared test harness.
            const deciding = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl: endpoint,
                serverIdentityId: serverId });
            const decisionInput = { artifactId, decision: scenario === 'reject' ? 'reject' as const : 'approve' as const };
            const decisionContext = { surface: 'cli' as const, authority: 'present_user' as const,
                runtimeAccountId: accountId, serverId, serverIdentityId: serverId };
            const decision = await deciding.execute('approval.request.decide', decisionInput, decisionContext);
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
            const result = await invoking;
            if (scenario === 'reject') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
                expect(readApproval().status).toBe('rejected');
            } else if (scenario === 'disable') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false, effectAttempted: false } });
            } else if (scenario === 'uncertain') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_account_storage_outcome_unknown' });
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false,
                    errorCode: 'plugin_account_storage_outcome_unknown', effectAttempted: true } });
            } else {
                expect(result).toMatchObject({ ok: true, result: { version: expect.any(Number) } });
                expect(readApproval()).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true } });
            }
            expect(writes).toBe(scenario === 'reject' || scenario === 'disable' ? 0 : 1);
            await deciding.execute('approval.request.decide', decisionInput, decisionContext);
            expect(writes).toBe(scenario === 'reject' || scenario === 'disable' ? 0 : 1);
            if (scenario === 'approve' || scenario === 'uncertain') {
                expect(stored).toMatchObject({ status: 'present', content: { t: 'plain', v: { values: {
                    approved: { value: 'written once' },
                } } } });
            }
        } finally {
            controller.abort();
            await invoking.catch(() => undefined);
            restore(); await app.close();
        }
    });
