import { randomUUID } from 'node:crypto';

import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import type { DaemonPluginChangeService } from './changeService';

/** Development observations propose the same install approval as public Actions. */
export function createDaemonPluginDevelopmentReviewApprovalPublisher(params: Readonly<{
  credentials: StoredCredentials;
  happyHomeDir: string;
  serverId?: string;
  resolveCurrentMachineExecutionOriginContext: () => Promise<CurrentMachineExecutionOriginContext | null>;
}>) {
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  return async (input: Readonly<{
    sourceRootPath: string;
    changeService: DaemonPluginChangeService;
  }>): Promise<void> => {
    const origin = await params.resolveCurrentMachineExecutionOriginContext();
    if (!origin) throw new Error('plugin_development_approval_origin_unavailable');
    await ensureCliActionPolicySettings(params.credentials, serverHttpBaseUrl);
    const executor = createCliActionExecutor({
      token: params.credentials.token,
      credentials: params.credentials,
      happyHomeDir: params.happyHomeDir,
      pluginChangeService: input.changeService,
      sessionId: '',
      mode: 'plain',
      ctx: null,
      serverId: params.serverId ?? configuration.activeServerId,
      serverIdentityId: origin.serverIdentityId,
      serverHttpBaseUrl,
    });
    const result = await executor.execute('plugins.install', {
      path: input.sourceRootPath, kind: 'path', dev: true,
    }, {
      surface: 'cli',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      executionRunTargetMachineId: origin.machineId,
      actionRequestId: randomUUID(),
    });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
  };
}
