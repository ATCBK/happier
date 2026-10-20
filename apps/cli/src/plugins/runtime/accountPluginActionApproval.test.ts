import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { PluginAccountStorageMutationRequestV1Schema, PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import * as accountChanges from '@/api/observeAccountChanges';
import { readStoredCredentialsForServerId, removeStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { readCurrentAccountPluginExecutionSelection } from './accountPluginActivationSource';

afterEach(() => vi.restoreAllMocks());

it.each([
    { scenario: 'approve', surface: 'cli' },
    { scenario: 'approve', surface: 'agent' },
    { scenario: 'approve', surface: 'mcp' },
    { scenario: 'reject', surface: 'cli' },
    { scenario: 'disable', surface: 'cli' },
    { scenario: 'uncertain', surface: 'cli' },
    { scenario: 'cancel', surface: 'cli' },
    { scenario: 'caller_retire', surface: 'cli' },
    { scenario: 'credential_rotate', surface: 'cli' },
    { scenario: 'credential_rotate_read', surface: 'cli' },
] as const)(
    'keeps the public authored Account write pending until a separate CLI decides: $surface $scenario', async ({ scenario, surface }) => {
        const app = fastify();
        const endpoint = 'http://account-approval.test';
        const rotatesCredentials = scenario === 'credential_rotate' || scenario === 'credential_rotate_read';
        const serverId = rotatesCredentials ? 'account-approval-rotation' : 'account-approval';
        const accountId = `account-owner-${surface}-${scenario}`;
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const rotateStoredCredentials = () => writeStoredCredentialsForServerId(serverId,
            { ...credentials, token: `${credentials.token}-rotated` });
        const { pluginId, providerPluginId, artifacts, setEnabled, setPluginEnabled } = await registerAuthoredAccountActionRelease(app, accountId,
            { includeAccountProvider: scenario === 'caller_retire' });
        const effectPluginId = scenario === 'caller_retire' ? providerPluginId : pluginId;
        if (!effectPluginId) throw new Error('Missing separately authored Account provider');
        const features = registerAccountHomeHttp(app, { accountId, serverId,
            ...(scenario === 'caller_retire' ? { settings: { actionsSettingsV1: setActionApprovalOverride({
                settings: normalizeActionsSettingsV1(undefined), actionId: formatQualifiedPluginActionId({ pluginId: effectPluginId, localId: 'record' }),
                surface: 'plugin', approvalRequired: true,
            }) } } : {}) });
        let approvalArtifactId: string | undefined;
        const readApproval = () => {
            if (!approvalArtifactId) throw new Error('Missing approval Artifact');
            const value = decodePlainArtifactStoredContent(artifacts.read(approvalArtifactId)!.body);
            if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string') throw new Error('Missing approval body');
            return StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(value.body));
        };
        let stored: ReturnType<typeof PluginAccountStorageReadResponseV1Schema.parse> = { status: 'absent' };
        let writes = 0;
        let rotatedDuringRead = false;
        app.get(`/v1/account/plugin-storage/${effectPluginId}`, async request => {
            if (scenario === 'credential_rotate_read' && !rotatedDuringRead) {
                // The handler has already entered. Home accepts its captured
                // bearer, then the stored sign-in changes before this read ends.
                expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
                await rotateStoredCredentials();
                rotatedDuringRead = true;
            }
            return stored;
        });
        app.post(`/v1/account/plugin-storage/${effectPluginId}`, async (request, reply) => {
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
        const createdApprovals: string[] = [];
        let publishArtifactId: ((id: string) => void) | undefined;
        const nextApprovalArtifact = () => new Promise<string>(resolve => {
            const artifactId = createdApprovals.shift();
            if (artifactId) resolve(artifactId);
            else publishArtifactId = resolve;
        });
        // Account change observation is the external socket adapter. The real
        // Artifact reader, decision writer, approval coordinator and invocation
        // policy remain bound by the normal CLI composition.
        vi.spyOn(accountChanges, 'observeAccountChanges').mockImplementation((options) => {
            if (options.entityId) {
                if (publishArtifactId) { const publish = publishArtifactId; publishArtifactId = undefined; publish(options.entityId); }
                else createdApprovals.push(options.entityId);
            }
            return { dispose: async () => {} };
        });
        const controller = new AbortController();
        if (rotatesCredentials) {
            await writeStoredCredentialsForServerId(serverId, credentials);
            expect(await readStoredCredentialsForServerId(serverId)).toEqual(credentials);
        }
        const original = createCliActionExecutorFromCredentials({ credentials, serverId, serverIdentityId: serverId,
            serverApiUrl: endpoint,
            ...(rotatesCredentials ? { readCredentials: () => readStoredCredentialsForServerId(serverId) } : {}) });
        let settled = false;
        const invoking = original.execute('action.invoke', { action: { pluginId, localId: scenario === 'caller_retire' ? 'record-source' : 'write' },
            input: scenario === 'caller_retire' ? { key: 'approved' } : { key: 'approved', value: 'written once' } }, { surface, signal: controller.signal,
            runtimeAccountId: accountId, serverId, serverIdentityId: serverId }).then(result => { settled = true; return result; });
        const deciding = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl: endpoint,
            serverIdentityId: serverId });
        const decisionContext = { surface: 'cli' as const, authority: 'present_user' as const,
            runtimeAccountId: accountId, serverId, serverIdentityId: serverId };
        const waitForApproval = async () => {
            const artifactId = await Promise.race([nextApprovalArtifact(), invoking.then(result => {
                throw new Error(`Account write settled before approval: ${JSON.stringify(result)}`);
            })]);
            approvalArtifactId = artifactId;
            return artifactId;
        };
        try {
            let artifactId = await waitForApproval();
            if (scenario === 'caller_retire') {
                expect(readApproval()).toMatchObject({ status: 'open', qualifiedActionId: `${pluginId}/actions/record-source` });
                expect(await deciding.execute('approval.request.decide', { artifactId, decision: 'approve' }, decisionContext))
                    .toMatchObject({ ok: true });
                artifactId = await waitForApproval();
            }
            expect(settled).toBe(false);
            expect(writes).toBe(0);
            expect(readApproval()).toMatchObject({ status: 'open', approvalInputCustody: 'live_only',
                qualifiedActionId: `${effectPluginId}/actions/${scenario === 'caller_retire' ? 'record' : 'write'}` });
            if (scenario === 'disable') setEnabled(false);
            if (scenario === 'caller_retire') {
                setPluginEnabled(pluginId, false);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'unavailable', code: 'plugin_disabled' });
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId: effectPluginId }))
                    .toMatchObject({ kind: 'available' });
            }
            const capturedAccountLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            const capturedAccountSnapshot = getActiveAccountSettingsSnapshot();
            if (scenario === 'credential_rotate') {
                // Rotate only the real stored credential. Home still accepts
                // the original token and the release/settings remain current.
                await rotateStoredCredentials();
                expect((await readStoredCredentialsForServerId(serverId))?.token).toBe(`${credentials.token}-rotated`);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'available' });
            }
            // This standalone public executor gets no plugin registry, replay
            // override, current-intent callback, Machine or shared test harness.
            if (scenario === 'cancel') {
                controller.abort();
                expect(await invoking).toMatchObject({ ok: false, errorCode: 'plugin_action_aborted' });
                // Detaching the original caller leaves history for an explicit
                // public cancellation; it never grants replay of live operands.
                expect(readApproval().status).toBe('open');
            }
            const decisionInput = { artifactId, decision: scenario === 'cancel' ? 'cancel' as const
                : scenario === 'reject' ? 'reject' as const : 'approve' as const };
            const decision = await deciding.execute('approval.request.decide', decisionInput, decisionContext);
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
            const result = await invoking;
            if (rotatesCredentials) {
                expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(capturedAccountLifetime);
                expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe(capturedAccountSnapshot?.scopeKey);
                expect(getActiveAccountSettingsSnapshot()?.settings).toEqual(capturedAccountSnapshot?.settings);
                expect((await readStoredCredentialsForServerId(serverId))?.token).toBe(`${credentials.token}-rotated`);
                expect(await readCurrentAccountPluginExecutionSelection({ credentials, serverUrl: endpoint, pluginId }))
                    .toMatchObject({ kind: 'available' });
            }
            if (scenario === 'credential_rotate_read') expect(rotatedDuringRead).toBe(true);
            const noEffect = scenario === 'reject' || scenario === 'disable' || scenario === 'cancel'
                || scenario === 'caller_retire' || rotatesCredentials;
            expect(writes).toBe(noEffect ? 0 : 1);
            if (scenario === 'cancel') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_aborted' });
                expect(readApproval().status).toBe('canceled');
                expect(await deciding.execute('approval.request.decide', { artifactId, decision: 'approve' }, decisionContext))
                    .toMatchObject({ ok: false, errorCode: 'approval_not_open' });
            } else if (scenario === 'reject') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_rejected' });
                expect(readApproval().status).toBe('rejected');
            } else if (scenario === 'disable' || scenario === 'caller_retire' || scenario === 'credential_rotate') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false, effectAttempted: false } });
            } else if (scenario === 'credential_rotate_read') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_account_storage_unavailable' });
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false,
                    errorCode: 'plugin_account_storage_unavailable', effectAttempted: true } });
            } else if (scenario === 'uncertain') {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_account_storage_outcome_unknown' });
                expect(readApproval()).toMatchObject({ status: 'failed', execution: { ok: false,
                    errorCode: 'plugin_account_storage_outcome_unknown', effectAttempted: true } });
            } else {
                expect(result).toMatchObject({ ok: true, result: { version: expect.any(Number) } });
                expect(readApproval()).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true } });
            }
            await deciding.execute('approval.request.decide', decisionInput, decisionContext);
            expect(writes).toBe(noEffect ? 0 : 1);
            if (scenario === 'approve' || scenario === 'uncertain') {
                expect(stored).toMatchObject({ status: 'present', content: { t: 'plain', v: { values: {
                    approved: { value: 'written once' },
                } } } });
            }
        } finally {
            controller.abort();
            await invoking.catch(() => undefined);
            if (rotatesCredentials) await removeStoredCredentialsForServerId(serverId);
            restore(); await app.close();
        }
    });
