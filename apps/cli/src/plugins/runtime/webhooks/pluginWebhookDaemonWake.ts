import type { ApiMachineClient } from '@/api/apiMachine';

import type { PluginWebhookDaemonWorkerHandleV1 } from './pluginWebhookDaemonWorker';

/**
 * The existing Account feed classifies durable queue/endpoint and admission
 * invalidations before waking the single-flight worker. Unrelated Account
 * traffic must not cancel its parked claim. No delivery content is carried.
 */
export function attachPluginWebhookDaemonWakeV1(params: Readonly<{
  apiMachine: Pick<ApiMachineClient, 'onPluginWebhookInvalidated'>;
  getWorker: () => Pick<PluginWebhookDaemonWorkerHandleV1, 'trigger'> | null;
}>): () => void {
  return params.apiMachine.onPluginWebhookInvalidated(() => {
    params.getWorker()?.trigger();
  });
}
