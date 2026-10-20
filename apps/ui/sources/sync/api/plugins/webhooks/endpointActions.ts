import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginWebhookActionInputSchemasV1, PluginWebhookActionOutputSchemasV1, type PluginWebhookPresentUserActionIdV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1, PluginWebhookAccountStatusRequestV1Schema, PluginWebhookAccountStatusResultV1Schema, PluginWebhookDeliveryDiscardInputV1Schema, PluginWebhookDeliveryDiscardResultV1Schema, PluginWebhookDeliveryReplayInputV1Schema, PluginWebhookDeliveryReplayResultV1Schema, type PluginWebhookAccountStatusRequestV1 } from '@happier-dev/protocol/plugins/webhooks/statusV1';

import { serverFetch, type ServerFetch } from '@/sync/http/client';

export type PluginWebhookEndpointUiActionExecutor = <TActionId extends PluginWebhookPresentUserActionIdV1>(
    actionId: TActionId,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

export function createPluginWebhookEndpointHttpActionExecutor(params: Readonly<{
    request?: ServerFetch;
}> = {}): PluginWebhookEndpointUiActionExecutor {
    const request = params.request ?? serverFetch;
    return async (actionId, input, options) => {
        const parsedInput = PluginWebhookActionInputSchemasV1[actionId].parse(input);
        const transport = getActionSpec(actionId).serverTransport;
        if (!transport) throw new TypeError(`Unsupported plugin webhook Action transport: ${actionId}`);
        const response = await request(transport.path, {
            method: transport.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsedInput),
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }, { includeAuth: true });
        const payload: unknown = await response.json();
        if (!response.ok) {
            const record = typeof payload === 'object' && payload !== null
                ? payload as Record<string, unknown>
                : {};
            throw new Error(typeof record.error === 'string'
                ? record.error
                : 'plugin_webhook_endpoint_request_failed');
        }
        return PluginWebhookActionOutputSchemasV1[actionId].parse(payload);
    };
}

async function requestWebhookJson(
    request: ServerFetch,
    path: string,
    input: unknown,
): Promise<unknown> {
    const response = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    }, { includeAuth: true });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error('plugin_webhook_status_request_failed');
    return payload;
}

export type PluginWebhookAdministrationHttpClient = Readonly<{
    executeAction: PluginWebhookEndpointUiActionExecutor;
    readStatus: (input: PluginWebhookAccountStatusRequestV1) => Promise<ReturnType<typeof PluginWebhookAccountStatusResultV1Schema.parse>>;
    replayDelivery: (input: unknown) => Promise<ReturnType<typeof PluginWebhookDeliveryReplayResultV1Schema.parse>>;
    discardDelivery: (input: unknown) => Promise<ReturnType<typeof PluginWebhookDeliveryDiscardResultV1Schema.parse>>;
}>;

export function createPluginWebhookAdministrationHttpClient(params: Readonly<{
    request?: ServerFetch;
    executeAction?: PluginWebhookEndpointUiActionExecutor;
}> = {}): PluginWebhookAdministrationHttpClient {
    const request = params.request ?? serverFetch;
    const executeAction = params.executeAction ?? createPluginWebhookEndpointHttpActionExecutor({ request });
    return Object.freeze({
        executeAction,
        readStatus: async (input: PluginWebhookAccountStatusRequestV1) => {
            const parsed = PluginWebhookAccountStatusRequestV1Schema.parse(input);
            return PluginWebhookAccountStatusResultV1Schema.parse(await requestWebhookJson(
                request,
                PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1,
                parsed,
            ));
        },
        replayDelivery: async (input: unknown) => {
            const parsed = PluginWebhookDeliveryReplayInputV1Schema.parse(input);
            return PluginWebhookDeliveryReplayResultV1Schema.parse(await executeAction(
                'plugin.webhook.delivery.replay',
                parsed,
            ));
        },
        discardDelivery: async (input: unknown) => {
            const parsed = PluginWebhookDeliveryDiscardInputV1Schema.parse(input);
            return PluginWebhookDeliveryDiscardResultV1Schema.parse(await executeAction(
                'plugin.webhook.delivery.discard',
                parsed,
            ));
        },
    });
}

const activePluginWebhookAdministrationClient = createPluginWebhookAdministrationHttpClient();

export async function readActivePluginWebhookAccountStatus(
    input: PluginWebhookAccountStatusRequestV1,
) {
    return await activePluginWebhookAdministrationClient.readStatus(input);
}
