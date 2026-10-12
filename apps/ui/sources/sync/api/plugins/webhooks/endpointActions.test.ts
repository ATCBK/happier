import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import {
    createPluginWebhookAdministrationHttpClient,
    createPluginWebhookEndpointHttpActionExecutor,
} from './endpointActions';

describe('plugin webhook endpoint HTTP Action executor', () => {
    it('uses the canonical present-user path and validates the strict response', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            revision: 1,
            contribution: { pluginId: 'acme.github', localId: 'issues' },
            targetMaterialization: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.github',
            },
            sourceInstanceId: 'source-1',
            routing: 'accountEndpoint',
            readiness: 'ready',
            publicUrl: 'https://server.example/v1/plugins/webhooks/opaque',
            createdAt: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const execute = createPluginWebhookEndpointHttpActionExecutor({ request: request as never });

        const result = await execute('plugin.webhook.endpoint.read', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        });

        expect(result).toMatchObject({ revision: 1, readiness: 'ready' });
        expect(request).toHaveBeenCalledWith(
            '/v1/plugins/webhooks/endpoints/read',
            expect.objectContaining({ method: 'POST' }),
            { includeAuth: true },
        );
    });

    it('rejects malformed success payloads instead of presenting partial endpoint state', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({ revision: 1 }), { status: 200 }));
        const execute = createPluginWebhookEndpointHttpActionExecutor({ request: request as never });

        await expect(execute('plugin.webhook.endpoint.read', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        })).rejects.toThrow();
    });
});

describe('plugin webhook Account administration HTTP client', () => {
    const deliveryOperations = [
        { method: 'replayDelivery', actionId: 'plugin.webhook.delivery.replay', path: '/v1/plugins/webhooks/deliveries/replay', kind: 'requeued' },
        { method: 'discardDelivery', actionId: 'plugin.webhook.delivery.discard', path: '/v1/plugins/webhooks/deliveries/discard', kind: 'discarded' },
    ] as const;

    function deliveryFixture(overrides: Partial<ActionExecutorDeps> = {}) {
        const storedApprovals = new Map<string, ApprovalRequest>();
        const request = vi.fn(async (path: string) => Response.json({
            kind: path.endsWith('/replay') ? 'requeued' : 'discarded', revision: 4,
        }));
        // Only authenticated HTTP and Artifact persistence are substituted; the
        // Action registry, input/output admission, policy and replay stay real.
        const transport = createPluginWebhookEndpointHttpActionExecutor({ request: request as never });
        const settings = ActionsSettingsV1Schema.parse({ v: 1 });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            pluginWebhookAction: ({ actionId, input }) => transport(actionId as Parameters<typeof transport>[0], input),
            isActionApprovalRequired: (actionId, context, input) =>
                isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input),
            isApprovalExecutionOriginCurrent: async () => true,
            approvalsCreate: async ({ request: approval }) => {
                storedApprovals.set('delivery-approval', approval);
                return { artifactId: 'delivery-approval' };
            },
            approvalsGet: async ({ artifactId }) => storedApprovals.get(artifactId) ?? null,
            approvalsUpdate: async ({ artifactId, request: approval }) => {
                storedApprovals.set(artifactId, approval);
                return { ok: true };
            },
            ...overrides,
        }));
        const hostExecutor = {
            // The production host supplies the invocation identity; the pure
            // Protocol executor deliberately cannot mint caller provenance.
            execute: ((actionId, input, context) => executor.execute(actionId, input, {
                ...context, actionRequestId: 'delivery-request', authority: 'present_user',
            })) satisfies typeof executor.execute,
        };
        const executeAction = createFrontDoorUiActionExecutor(hostExecutor, { serverId: 'webhook-home' });
        return {
            request, executor, storedApprovals,
            client: createPluginWebhookAdministrationHttpClient({ request: request as never, executeAction }),
        };
    }

    it.each(deliveryOperations)('requires approval for $method and records the accepted delivery receipt once', async operation => {
        const { client, request, storedApprovals, executor } = deliveryFixture();
        // Pending approval is not a successful delivery receipt; the retained
        // dead-letter membership must only settle after the actual effect.
        await expect(client[operation.method]({ deliveryId: 'delivery-1', expectedRevision: 3 })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
        expect(storedApprovals.get('delivery-approval')).toMatchObject({
            status: 'open', actionId: operation.actionId,
            actionArgs: { deliveryId: 'delivery-1', expectedRevision: 3 },
        });

        await expect(executor.execute('approval.request.decide', {
            artifactId: 'delivery-approval', decision: 'approve',
        }, { surface: 'ui', serverId: 'webhook-home', authority: 'present_user' })).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });
        expect(storedApprovals.get('delivery-approval')).toMatchObject({
            status: 'executed', execution: { ok: true, result: { kind: operation.kind, revision: 4 } },
        });
        expect(request).toHaveBeenCalledWith(operation.path, expect.objectContaining({
            method: 'POST', body: JSON.stringify({ deliveryId: 'delivery-1', expectedRevision: 3 }),
        }), { includeAuth: true });
        await executor.execute('approval.request.decide', { artifactId: 'delivery-approval', decision: 'approve' },
            { surface: 'ui', serverId: 'webhook-home', authority: 'present_user' });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(deliveryOperations)('refuses $method at the shared policy boundary without a transport effect', async operation => {
        const { client, request } = deliveryFixture({ isActionEnabled: () => false });
        await expect(client[operation.method]({ deliveryId: 'delivery-1', expectedRevision: 3 }))
            .rejects.toThrow('action_disabled');
        expect(request).not.toHaveBeenCalled();
    });

    it.each(deliveryOperations)('keeps $method unexecuted when the present user rejects approval', async operation => {
        const { client, request, storedApprovals, executor } = deliveryFixture();
        await expect(client[operation.method]({ deliveryId: 'delivery-1', expectedRevision: 3 })).rejects.toThrow();
        await expect(executor.execute('approval.request.decide', {
            artifactId: 'delivery-approval', decision: 'reject',
        }, { surface: 'ui', serverId: 'webhook-home', authority: 'present_user' })).resolves.toMatchObject({ ok: true });
        expect(storedApprovals.get('delivery-approval')).toMatchObject({ status: 'rejected' });
        expect(request).not.toHaveBeenCalled();
    });

    it.each(deliveryOperations)('returns the exact $method receipt when the user waives approval', async operation => {
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            [operation.actionId]: ['ui'],
        } });
        const { client, request } = deliveryFixture({ isActionApprovalRequired: (actionId, context, input) =>
            isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input) });
        await expect(client[operation.method]({ deliveryId: 'delivery-1', expectedRevision: 3 }))
            .resolves.toEqual({ kind: operation.kind, revision: 4 });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each(deliveryOperations)('does not retry $method when the delivery effect loses its response', async operation => {
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            [operation.actionId]: ['ui'],
        } });
        const { client, request } = deliveryFixture({ isActionApprovalRequired: (actionId, context, input) =>
            isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input) });
        let deliveryChanged = false;
        request.mockImplementationOnce(async () => {
            deliveryChanged = true;
            throw new Error('response_lost');
        });
        await expect(client[operation.method]({ deliveryId: 'delivery-1', expectedRevision: 3 })).rejects.toThrow();
        expect(deliveryChanged).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reads only the strict bounded status projection through the authenticated server client', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            endpoints: [{
                webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
                revision: 1,
                contribution: { pluginId: 'acme.github', localId: 'issues' },
                targetMaterialization: {
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                    pluginId: 'acme.github',
                },
                sourceInstanceId: 'source-1',
                routing: 'accountEndpoint',
                readiness: 'ready',
                targetStatus: 'current',
                publicUrl: 'https://server.example/v1/plugins/webhooks/opaque',
                createdAt: 1,
                queue: { queued: 1, retrying: 0, claimed: 0, deadLetter: 0, oldestPendingAtMs: 1 },
            }],
            nextEndpointCursor: null,
            deadLetters: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const client = createPluginWebhookAdministrationHttpClient({ request: request as never });

        await expect(client.readStatus({ pageSize: 50, deadLetterPageSize: 50 }))
            .resolves.toMatchObject({ endpoints: [{ readiness: 'ready' }] });
        expect(request).toHaveBeenCalledWith(
            '/v1/plugins/webhooks/status/read',
            expect.objectContaining({ method: 'POST' }),
            { includeAuth: true },
        );
    });

    it('rejects status responses that leak a raw delivery payload', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            endpoints: [],
            nextEndpointCursor: null,
            deadLetters: [],
            rawBody: '{}',
        }), { status: 200 }));
        const client = createPluginWebhookAdministrationHttpClient({ request: request as never });

        await expect(client.readStatus({ pageSize: 50, deadLetterPageSize: 50 })).rejects.toThrow();
    });
});
