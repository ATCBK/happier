import fastify from 'fastify';
import type { ActionExecutorContext, PluginDevLoopActionIdV1 } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import {
  PROMPT_LIBRARY_ROWS_ROUTE_V1,
  PromptLibraryCatalogKeyV1Schema,
  PromptLibraryRowsListResponseV1Schema,
  sealPromptLibraryContentV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema,
  type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';

/** Real CLI parser, Action admission and plugin owners beneath Account HTTP/daemon boundaries. */
export async function createPluginCliActionHost(options: Readonly<{ happyHomeDir?: string }> = {}) {
  const origin = 'http://plugin-command-home.test';
  const credentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: 'plugin-command-account', tokenEpoch: 0,
      provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
    })).toString('base64url')}.fixture`,
    credentialProvenance: 'stored_session' as const,
    encryption: null,
  };
  const previous = getActiveAccountSettingsSnapshot();
  const policy = { v: 1 as const, approvalWaivedSurfaces: {
    'plugins.install': ['cli' as const, 'agent' as const], 'plugins.uninstall': ['cli' as const],
    'plugins.enable': ['cli' as const],
  } };
  // This suite deliberately exercises the allowed Settings waiver. It must not
  // waive the separate daemon-issued Install & Trust decision.
  const settings = accountSettingsParse({ ...previous?.settings, actionsSettingsV1: policy });
  const rawSettings = { ...previous?.rawSettings, actionsSettingsV1: policy };
  const scopeKey = runWithServerHttpBaseUrl(origin, () => resolveAccountSettingsScopeKey(credentials));
  setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, settings, rawSettings,
    settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
    ...(previous?.promptLibraryCatalog ? { promptLibraryCatalog: previous.promptLibraryCatalog } : {}),
  });
  const app = fastify({ logger: false });
  const delivered: ExternalActionRequestEnvelope[] = [];
  app.addHook('preHandler', async request => {
    if (request.headers.authorization !== `Bearer ${credentials.token}`) {
      throw new Error('Plugin CLI requested another Account');
    }
  });
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/account/encryption/currentness', async () => AccountEncryptionCurrentnessResponseSchema.parse({
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
  }));
  app.get('/v2/account/settings', async () => ({ version: 1, content: { t: 'plain', v: rawSettings } }));
  app.get('/v1/machines', async () => ['machine-1', 'machine-2'].map(id => ExternalActionMachineBootstrapV1Schema.parse({
    id, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
    installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
    access: { custodian: { accountId: 'plugin-command-account', displayName: 'Fixture Account' },
      role: 'manage', resourceMode: 'plain', accessState: 'ready' },
  })));
  app.get(PROMPT_LIBRARY_ROWS_ROUTE_V1, async () => PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
      content: sealPromptLibraryContentV1({ mode: 'plain', material: null,
        record: previous?.promptLibraryCatalog?.status === 'ready'
          ? previous.promptLibraryCatalog.rows.find(row => row.record.key === key)?.record ?? emptyPromptLibraryRecordV1(key)
          : emptyPromptLibraryRecordV1(key) }),
    })),
  }));
  // HTTP is the genuine Home→Machine dispatch boundary. The selected receiver
  // runs the real Action/source owner below it, rather than a canned install.
  app.post<{ Params: { actionId: PluginDevLoopActionIdV1 } }>('/v1/actions/:actionId', async request => {
    const envelope = ExternalActionRequestEnvelopeSchema.parse(request.body);
    delivered.push(envelope);
    if (envelope.v !== 1 || envelope.target?.kind !== 'machine') throw new Error('Expected Plain Machine delivery');
    const currentMachineId = envelope.target.machineId;
    const receiver = runWithServerHttpBaseUrl(origin, () => createCliActionExecutor({
      token: credentials.token, credentials, mode: 'plain', ctx: null, sessionId: 'fixture-receiver',
      rawSession: { path: '/fixture-workspace' }, serverId: 'plugin-command-home', serverHttpBaseUrl: origin,
      ...(options.happyHomeDir ? { happyHomeDir: options.happyHomeDir } : {}),
      pluginActionExecutionOwner: 'current_process',
    }));
    const response = await executeExternalAction({ actionId: request.params.actionId, envelope,
      principal: { authority: 'present_user' }, surface: 'cli', currentMachineId,
      currentAccountId: 'plugin-command-account', currentServerId: 'plugin-command-home',
      currentServerHttpBaseUrl: origin,
      resolveTarget: async ({ target }) => target?.kind === 'machine' && target.machineId === currentMachineId ? target : null,
      executor: receiver,
    });
    if (response.kind !== 'response') throw new Error(`Invalid Plugin Action envelope: ${response.errorCode}`);
    return ExternalActionResponseEnvelopeV1Schema.parse(response.response);
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const executePluginAction = async (actionId: PluginDevLoopActionIdV1, input: unknown,
    context: ActionExecutorContext = {}, machineId?: string) => await runWithServerHttpBaseUrl(origin,
    () => createCliActionExecutorFromCredentials({ credentials, serverId: 'plugin-command-home', serverApiUrl: origin,
      ...(machineId ? { machineId } : {}),
    }).execute(actionId, input, { surface: 'cli', authority: 'present_user', ...context }));
  return {
    delivered,
    executePluginAction,
    async executeInstall(input: unknown, context: ActionExecutorContext = {}, machineId?: string) {
      return await executePluginAction('plugins.install', input, context, machineId);
    },
    async run(args: readonly string[]) {
      const argv = ['plugins', ...args];
      const command = findCompiledActionCliCommand(argv, listCompiledActionCliCommands());
      if (!command) throw new Error('Missing compiled plugin command');
      await runWithServerHttpBaseUrl(origin, () => runCompiledActionCliCommand({ command, argv, deps: {
        readCredentialsFn: async () => credentials,
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          credentials, serverId: 'plugin-command-home', serverApiUrl: origin,
        }),
      } }));
    },
    async dispose() { restore(); await app.close(); },
  };
}
