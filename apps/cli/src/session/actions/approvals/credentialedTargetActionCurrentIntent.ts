import type { StoredCredentials } from '@/persistence';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';
import { logger } from '@/ui/logger';

/** Bind the incumbent target-Action approval owner to this Home's Account material. */
export function createCredentialedTargetActionCurrentIntent(
  credentials: StoredCredentials,
): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const store = createCliApprovalsArtifactStore({ credentials });
  return async currentIntent => {
    const serverUrl = resolveServerHttpBaseUrl();
    const reportUnavailable: NonNullable<typeof currentIntent.reportUnavailable> = currentIntent.reportUnavailable
      ?? (reason => logger.debug('[RPC] Target Action current intent unavailable', {
        code: 'plugin_action_current_intent_unavailable', reason,
      }));
    return await runWithServerHttpBaseUrl(serverUrl, () => createTargetActionCurrentIntentAdapter({
      create: request => store.targetActionApprovalsCreate({ request }),
      read: artifactId => runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsGet({ artifactId })),
      update: args => runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsUpdate(args)),
      subscribeChanges: (artifactId, onChange, onError) => observeAccountChanges({
        token: credentials.token,
        serverUrl,
        entityId: artifactId,
      }, { onChange, onError }),
    })({ ...currentIntent, reportUnavailable }));
  };
}
