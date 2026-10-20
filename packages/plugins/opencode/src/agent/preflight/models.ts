import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { probeOpenCodePreflightCatalogs, resolveOpenCodePreflightProbeVariant, withOpenCodePreflightServer } from './catalogs.js';
import type { OpenCodeServerClient } from '../runtime/server/openCodeServerClient.js';
import { resolveOpenCodeBackendMode } from '../runtime/mode.js';
import { OPENCODE_CHILD_LAUNCH_ENV_KEYS } from '../runtime/server/spawnSpec.js';
import { isOpenCodeModelSelectable } from '../models/eligibility.js';
import { buildOpenCodeThinkingModelOptionsFromVariants } from '../config/thinking.js';
import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';
import { prepareOpenCodeQualifiedConnectedAccounts } from '../auth/services/qualifiedPurposeLaunch.js';
import {
  OPEN_CODE_STABLE_SYSTEM_TOOL_ID,
  OPEN_CODE_SYSTEM_TOOL_ID,
  OPEN_CODE_V2_SYSTEM_TOOL_ID,
  resolveOpenCodeSystemToolId,
} from '../systemTool.js';

export type OpenCodePreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  modelOptions?: NonNullable<ReturnType<typeof buildOpenCodeThinkingModelOptionsFromVariants>>;
}>;

function modelSupportsReasoningVariants(record: Readonly<Record<string, unknown>>): boolean {
  const variants = record.variants;
  if (Array.isArray(variants)) return variants.length > 0;
  return asRecord(record.capabilities)?.reasoning === true;
}

function readContextWindowTokens(record: Readonly<Record<string, unknown>>): number | undefined {
  const value = asRecord(record.limit)?.context;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function buildOpenCodePreflightModels(
  blocks: readonly Readonly<{ fullId: string; record: Readonly<Record<string, unknown>> }>[],
  nowMs: number,
): readonly OpenCodePreflightModel[] | null {
  const models = blocks
    .map((block): OpenCodePreflightModel | null => {
      const providerId = block.fullId.slice(0, block.fullId.indexOf('/'));
      if (!isOpenCodeModelSelectable({ providerID: providerId, modelID: block.fullId.slice(providerId.length + 1), modelRecord: block.record, nowMs })) return null;
      const name = normalizeString(block.record.name) || block.fullId;
      const description = normalizeString(block.record.family) || normalizeString(block.record.providerID);
      const contextWindowTokens = readContextWindowTokens(block.record);
      const modelOptions = modelSupportsReasoningVariants(block.record)
        ? buildOpenCodeThinkingModelOptionsFromVariants(block.record.variants, null)
        : null;
      return {
        id: block.fullId,
        name,
        ...(description ? { description } : {}),
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      };
    })
    .filter((model): model is OpenCodePreflightModel => model !== null);

  return models;
}

/** Both preflight and bound Sessions consume the native server's provider inventory. */
export function buildOpenCodeModelsFromProviders(
  providers: Awaited<ReturnType<OpenCodeServerClient['providersList']>>,
  observedAt: number,
): readonly OpenCodePreflightModel[] | null {
  const blocks = providers.flatMap((provider) => Object.entries(provider.models ?? {}).flatMap(([id, raw]) => {
    const record = asRecord(raw);
    return record ? [{ fullId: `${provider.id}/${normalizeString(record.id) || id}`, record }] : [];
  }));
  return buildOpenCodePreflightModels(blocks, observedAt);
}

export const OPENCODE_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  prepareLaunchEnvironment: async ({ environment, connectedAccounts, signal }) => {
    const prepared = await prepareOpenCodeQualifiedConnectedAccounts({ launchEnvironment: { values: environment, unset: [] } }, {
      signal, services: { connectedAccounts },
    });
    return { environment: prepared.request.launchEnvironment?.values ?? environment,
      unset: prepared.request.launchEnvironment?.unset, dispose: prepared.dispose };
  },
  resolveProbeVariant: resolveOpenCodePreflightProbeVariant,
  probeCatalogs: probeOpenCodePreflightCatalogs,
  probeModels: async context => {
    const backendMode = resolveOpenCodeBackendMode({ runtimeDescriptorV1: context.runtimeDescriptorV1,
      configuredBackendMode: context.runtimeKindOverride, accountSettings: context.accountSettings });
    if (backendMode === 'acp') {
      const toolId = resolveOpenCodeSystemToolId(context.accountSettings?.opencodeCliGeneration);
      return (await context.probeDeclaredAcpSessionControls?.({ toolId, args: ['acp'] }))?.models ?? null;
    }
    return await withOpenCodePreflightServer(context, async client =>
      buildOpenCodeModelsFromProviders(await client.providersList(), Date.now()));
  },
  managedServiceCommands: Object.freeze([OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID].map((toolId) => Object.freeze({
    toolId, args: Object.freeze(['serve', '--hostname', '127.0.0.1']),
    environmentKeys: Object.freeze([...OPENCODE_CHILD_LAUNCH_ENV_KEYS, 'OPENCODE_PERMISSION', 'OPENCODE_DISABLE_PRUNE', 'OPENCODE_SERVER_PASSWORD']), ci: 'omit' as const,
  }))),
  jsonRpcCommands: Object.freeze([OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID].flatMap((toolId) => [
    Object.freeze({ toolId, args: Object.freeze(['--version']) }),
    Object.freeze({ toolId, args: Object.freeze(['acp']) }),
  ])),
} satisfies AgentPreflightSessionControlsContributionV1);
