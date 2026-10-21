import type { HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand'
import type { McpServerConfig } from '@/agent'
import type { StoredCredentials } from '@/persistence'
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider'
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller'
import type {
  AccountSettings,
  ActionId,
  ActionExecutorDeps,
  ActionsSettingsV1,
  SessionRunPromptReadActionIdV1,
} from '@happier-dev/protocol'

function isTruthyEnvFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y'
}

function serializeActionSettingsForEnv(
  accountSettings: AccountSettings | null | undefined,
  scopedActionSettings?: ActionsSettingsV1,
): string | null {
  const actionSettings = scopedActionSettings
    ?? (accountSettings?.actionsSettingsV1 as ActionsSettingsV1 | undefined)
  if (actionSettings) {
    try {
      return JSON.stringify(actionSettings)
    } catch {
      return null
    }
  }

  const actionSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1
  return typeof actionSettingsEnv === 'string' && actionSettingsEnv.length > 0 ? actionSettingsEnv : null
}

function withActionSettingsEnv(
  config: McpServerConfig,
  accountSettings?: AccountSettings | null,
  scopedActionSettings?: ActionsSettingsV1,
): McpServerConfig {
  const actionSettings = serializeActionSettingsForEnv(accountSettings, scopedActionSettings)
  if (typeof actionSettings !== 'string' || actionSettings.length === 0) {
    return config
  }

  return {
    ...config,
    env: {
      ...(config.env ?? {}),
      HAPPIER_ACTIONS_SETTINGS_V1: actionSettings,
    },
  }
}

async function resolveHappierMcpServerConfig(
  url: string,
  _commandMode: 'direct-script' | 'current-process',
  accountSettings?: AccountSettings | null,
  scopedActionSettings?: ActionsSettingsV1,
): Promise<McpServerConfig> {
  const config = await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.ts'],
    args: ['--url', url],
    preferSourceEntrypoint: isTruthyEnvFlag(process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT),
  })
  return withActionSettingsEnv(config, accountSettings, scopedActionSettings)
}

export async function createHappierMcpBridge(
  session: HappyMcpSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
    sessionCredentials?: StoredCredentials | null
    credentials?: StoredCredentials | null
    isCredentialCurrent?: () => boolean | Promise<boolean>
    authorityScope?: 'account' | 'session'
    sessionList?: ActionExecutorDeps['sessionList']
    accountSettings?: AccountSettings | null
    getAccountSettings?: (() => AccountSettings | null) | null
    actionsSettingsProvider?: RuntimeActionSettingsProvider
    requiredDirectActionIds?: readonly ActionId[]
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease
  } = {},
): Promise<{
  happierMcpServer: {
    url: string
    supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[]
    readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>
    stop: () => void
  }
  mcpServers: Record<string, McpServerConfig>
}> {
  return createHappierMcpBridgeWithOptions(session, opts)
}

export async function createHappierMcpBridgeWithOptions(
  session: HappyMcpSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
    sessionCredentials?: StoredCredentials | null
    credentials?: StoredCredentials | null
    isCredentialCurrent?: () => boolean | Promise<boolean>
    authorityScope?: 'account' | 'session'
    sessionList?: ActionExecutorDeps['sessionList']
    accountSettings?: AccountSettings | null
    getAccountSettings?: (() => AccountSettings | null) | null
    actionsSettingsProvider?: RuntimeActionSettingsProvider
    requiredDirectActionIds?: readonly ActionId[]
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease
  } = {},
): Promise<{
  happierMcpServer: {
    url: string
    supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[]
    readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>
    stop: () => void
  }
  mcpServers: Record<string, McpServerConfig>
}> {
  const { startHappyServer } = await import('@/mcp/startHappyServer')
  const happierMcpServer = await startHappyServer(session, {
    sessionCredentials: opts.sessionCredentials ?? opts.credentials ?? null,
    credentials: opts.credentials ?? null,
    isCredentialCurrent: opts.isCredentialCurrent,
    authorityScope: opts.authorityScope ?? 'account',
    ...(opts.sessionList ? { sessionList: opts.sessionList } : {}),
    accountSettings: opts.accountSettings ?? null,
    getAccountSettings: opts.getAccountSettings ?? null,
    ...(opts.actionsSettingsProvider
      ? { actionsSettingsProvider: opts.actionsSettingsProvider }
      : {}),
    ...(opts.requiredDirectActionIds
      ? { requiredDirectActionIds: opts.requiredDirectActionIds }
      : {}),
    ...(opts.pluginRuntimeRegistryLease
      ? { pluginRuntimeRegistryLease: opts.pluginRuntimeRegistryLease }
      : {}),
  })
  const commandMode = opts.commandMode ?? 'direct-script'
  const scopedActionSettings = opts.actionsSettingsProvider?.getActionsSettings()
  const mcpServers: Record<string, McpServerConfig> = {
    happier: await resolveHappierMcpServerConfig(
      happierMcpServer.url,
      commandMode,
      opts.accountSettings ?? null,
      scopedActionSettings,
    ),
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
