import { readStoredCredentials } from '@/persistence';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';

import {
    createStablePluginApprovalQueueOwner,
    type StablePluginApprovalQueueOwner,
} from './approvalQueue';

export function createProductionPluginApprovalQueueOwner(params?: Readonly<{
    readCredentials?: typeof readStoredCredentials;
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
    recordDiagnostic?: Parameters<typeof createStablePluginApprovalQueueOwner>[0]['recordDiagnostic'];
}>): StablePluginApprovalQueueOwner {
    const readCredentials = params?.readCredentials ?? readStoredCredentials;
    return createStablePluginApprovalQueueOwner({
        async resolveExecutor() {
            const credentials = await readCredentials().catch(() => null);
            if (!credentials) return null;
            // Runner services are installed before an approval needs an Action
            // executor; admission resolves that enclosing runtime on demand.
            const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
            return createCliActionExecutorFromCredentials({
                credentials,
                ...(params?.actionsSettingsProvider
                    ? { actionsSettingsProvider: params.actionsSettingsProvider }
                    : {}),
            });
        },
        ...(params?.recordDiagnostic ? { recordDiagnostic: params.recordDiagnostic } : {}),
    });
}
