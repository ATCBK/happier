import type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';
import { formatVoiceToolResultsFollowUp, VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX } from '@happier-dev/protocol/voice/toolResultsChannel';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isBundledAgentId } from '@happier-dev/agents';
import { resolveVoiceToolResultHumanSummary } from './resolveVoiceToolResultHumanSummary';
import { isVoiceToolResultBlockedByPrivacy, redactVoiceToolResultForProvider, redactVoiceToolResultValue,
  type VoiceToolResultRedactionPrefs } from './redactVoiceToolResult';

type VoiceToolResultPrivacyPrefs = VoiceToolResultRedactionPrefs;

const FOLLOW_UP_RESULT_MAX_ITEMS = 8;
const FOLLOW_UP_RESULT_MAX_STRING_LENGTH = 160;
const FOLLOW_UP_RESULT_OMITTED_KEYS = new Set(['uiConnectedService', 'flavorAliases']);
const PROVIDER_RESULT_ARGUMENT_OMITTED_TOOL_NAMES = new Set([
  getActionSpec('action.invoke').bindings?.voiceClientToolName,
  getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName,
].filter((value): value is string => typeof value === 'string' && value.length > 0));

function readBackendIdFromTargetKey(targetKey: string): string | null {
  const trimmed = String(targetKey ?? '').trim();
  if (!trimmed.startsWith('backend:')) return null;
  const rest = trimmed.slice('backend:'.length);
  const parts = rest.split(':');
  const backendId = parts[0]?.trim() ?? '';
  return backendId ? backendId : null;
}

function selectListItemsForFollowUp(params: Readonly<{
  rawItems: ReadonlyArray<Record<string, unknown>>;
  pinnedTargetKeys: ReadonlySet<string>;
  maxItems: number;
}>): ReadonlyArray<Record<string, unknown>> {
  const pinned = new Set<string>(params.pinnedTargetKeys);

  // If there are any non-built-in backends (configured/plugin), pin the first one so we don't
  // accidentally drop it when we slice down large catalog responses for the follow-up prompt.
  for (const item of params.rawItems) {
    const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
    if (!targetKey) continue;
    const backendId = readBackendIdFromTargetKey(targetKey);
    if (backendId && !isBundledAgentId(backendId)) {
      pinned.add(targetKey);
      break;
    }
  }

  const selected: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of params.rawItems) {
    if (selected.length >= params.maxItems) break;
    const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
    if (!targetKey || !pinned.has(targetKey) || seen.has(targetKey)) continue;
    seen.add(targetKey);
    selected.push(item);
  }

  for (const item of params.rawItems) {
    if (selected.length >= params.maxItems) break;
    const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
    if (targetKey && seen.has(targetKey)) continue;
    if (targetKey) seen.add(targetKey);
    selected.push(item);
  }

  return selected;
}

function compactToolResultValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > FOLLOW_UP_RESULT_MAX_STRING_LENGTH
      ? `${value.slice(0, FOLLOW_UP_RESULT_MAX_STRING_LENGTH - 1)}…`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, FOLLOW_UP_RESULT_MAX_ITEMS).map((entry) => compactToolResultValue(entry));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FOLLOW_UP_RESULT_OMITTED_KEYS.has(key))
      .map(([key, entryValue]) => [key, compactToolResultValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined);

    return Object.fromEntries(entries);
  }

  return String(value);
}

export function compactToolResultsForFollowUp(
  toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
  prefs: VoiceToolResultPrivacyPrefs,
): ReadonlyArray<LocalVoiceAgentToolResultEntry> {
  const pinnedBackendTargetKeys = new Set<string>();
  for (const entry of toolResults) {
    if (entry.t !== 'listAgentModels') continue;
    const args = entry.args as { backendTargetKey?: unknown } | null | undefined;
    const backendTargetKey = typeof args?.backendTargetKey === 'string' ? args.backendTargetKey.trim() : '';
    if (backendTargetKey) {
      pinnedBackendTargetKeys.add(backendTargetKey);
    }
  }

  return toolResults.map((entry) => {
    if (isVoiceToolResultBlockedByPrivacy(entry.t, prefs)) {
      return {
        t: entry.t,
        args: null,
        result: {
          ok: false,
          errorCode: 'privacy_disabled',
          errorMessage: 'privacy_disabled',
        },
      };
    }

    const humanSummary = resolveVoiceToolResultHumanSummary({
      toolName: entry.t,
      toolInput: entry.args,
      toolResult: entry.result,
      shareFilePaths: prefs.shareFilePaths,
      shareSessionSummary: prefs.shareSessionSummary,
    });

    if (entry.t === 'listAgentBackends') {
      const result = entry.result;
      const rawItems = Array.isArray((result as { items?: unknown })?.items)
        ? ((result as { items: ReadonlyArray<Record<string, unknown>> }).items ?? [])
        : [];
      const items = selectListItemsForFollowUp({
        rawItems,
        pinnedTargetKeys: pinnedBackendTargetKeys,
        maxItems: FOLLOW_UP_RESULT_MAX_ITEMS,
      }).map((item) => {
            const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
            return {
              ...((targetKey.startsWith('acpBackend:') || targetKey.startsWith('backend:')) ? { targetKey } : {}),
              agentId: typeof item?.agentId === 'string' ? item.agentId : '',
              label: typeof item?.label === 'string' ? item.label : '',
              enabled: item?.enabled !== false,
              experimental: item?.experimental === true,
            };
          });

      return {
        t: entry.t,
        args: compactToolResultValue(redactVoiceToolResultValue(entry.args, prefs)),
        result: {
          ...(result && typeof result === 'object' && (result as { ok?: unknown }).ok === false ? { ok: false } : { ok: true }),
          ...(humanSummary ? { summary: humanSummary } : {}),
          items,
        },
      };
    }

    if (entry.t === 'listAgentModels') {
      const result = entry.result;
      const items = Array.isArray((result as { items?: unknown })?.items)
        ? ((result as { items: ReadonlyArray<Record<string, unknown>> }).items ?? []).slice(0, FOLLOW_UP_RESULT_MAX_ITEMS).map((item) => ({
            modelId: typeof item?.modelId === 'string' ? item.modelId : '',
            label: typeof item?.label === 'string' ? item.label : '',
            ...(typeof item?.providerConnectionId === 'string'
              ? { providerConnectionId: item.providerConnectionId }
              : item?.providerConnectionId === null
                ? { providerConnectionId: null }
                : {}),
            ...(typeof item?.providerName === 'string' && item.providerName.trim().length > 0
              ? { providerName: item.providerName }
              : {}),
          }))
        : [];

      return {
        t: entry.t,
        args: compactToolResultValue(redactVoiceToolResultValue(entry.args, prefs)),
        result: {
          ...(typeof (result as { agentId?: unknown })?.agentId === 'string' ? { agentId: (result as { agentId: string }).agentId } : {}),
          ...(typeof (result as { source?: unknown })?.source === 'string' ? { source: (result as { source: string }).source } : {}),
          ...(result && typeof result === 'object' && typeof (result as { supportsFreeform?: unknown }).supportsFreeform === 'boolean'
            ? { supportsFreeform: (result as { supportsFreeform: boolean }).supportsFreeform }
            : {}),
          ...(humanSummary ? { summary: humanSummary } : {}),
          items,
        },
      };
    }

    return {
      t: entry.t,
      // The provider already owns the originating call. Repeating these arguments in the
      // result channel would disclose Action input or an ephemeral current-UI command id.
      args: PROVIDER_RESULT_ARGUMENT_OMITTED_TOOL_NAMES.has(entry.t)
        ? null
        : compactToolResultValue(redactVoiceToolResultValue(entry.args, prefs)),
      result: (() => {
        const compacted = compactToolResultValue(redactVoiceToolResultForProvider(
          entry.t,
          entry.result,
          prefs,
        ));
        if (!humanSummary) {
          return compacted;
        }
        if (compacted && typeof compacted === 'object' && !Array.isArray(compacted)) {
          return { ...compacted, summary: humanSummary };
        }
        return { summary: humanSummary, value: compacted };
      })(),
    };
  });
}

export function buildToolResultsFollowUpPrompt(
  toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
  prefs: VoiceToolResultPrivacyPrefs,
): string {
  const hasErrors = toolResults.some((entry) => {
    const result = entry.result;
    if (!result || typeof result !== 'object') {
      return false;
    }
    const ok = (result as { ok?: unknown }).ok;
    const errorCode = (result as { errorCode?: unknown }).errorCode;
    return ok === false || typeof errorCode === 'string';
  });

  const instruction = hasErrors
    ? `${VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX} At least one action failed. Do not claim success, do not repeat a requested success token, and explain the failure plainly.`
    : `${VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX} All actions succeeded. Summarize the completed outcome accurately.`;

  return `${formatVoiceToolResultsFollowUp({ toolResults: compactToolResultsForFollowUp(toolResults, prefs) })}\n${instruction}`;
}
