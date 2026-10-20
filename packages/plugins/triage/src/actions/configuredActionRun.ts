import type { JsonValue, PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { runTriageConfiguredActionV1, type TriageConfiguredActionRunRequestV1 } from '../sessions/configuredActionRun.js';
import { readTriageEntrySessionFactsV1, readTriageRetainedEntrySessionFactsV1 } from '../sessions/readEntrySessionFacts.js';
import {
    TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1,
    TriageRunConfiguredActionResultV1Schema,
    type TriageRunConfiguredActionInputV1,
    type TriageRunConfiguredActionResultV1,
} from './configuredActionRunProtocol.js';

/** Client transport of the configured-run owner, with exact source-owned entry facts. */
export function createTriageRunConfiguredActionHandler(): PluginClientActionHandler<
    TriageRunConfiguredActionInputV1, TriageRunConfiguredActionResultV1
> {
    return async (input, context) => {
        const host = context.ui;
        if (context.signal.aborted) return { v: 1, status: 'cancelled' };
        const continuing = input.resumeStart !== undefined || input.resumeReview !== undefined;
        const sourceContext = await host.context({ signal: context.signal }).catch((error: unknown) => {
            if (!continuing) throw error;
            return { targetedContributions: null };
        });
        if (context.signal.aborted) return { v: 1, status: 'cancelled' };
        if (!continuing && sourceContext.targetedContributions === null) {
            return { v: 1, status: 'unavailable', reason: 'sourceContextUnavailable' };
        }
        const entries: Array<TriageConfiguredActionRunRequestV1['entries'][number]> = [];
        const unavailableKeys: string[] = [];
        const retainedInputs = input.resumeStart?.state.kind === 'single' ? [input.resumeStart.state.input]
            : input.resumeStart?.state.kind === 'bulk' ? input.resumeStart.state.units.map((unit) => unit.input) : [];
        for (const selected of input.entries) {
            if (context.signal.aborted) break;
            const key = triageEntryRowKey(selected.entryRef);
            const facts = continuing
                ? readTriageRetainedEntrySessionFactsV1(selected, retainedInputs, sourceContext.targetedContributions)
                : await readTriageEntrySessionFactsV1(host, selected, sourceContext.targetedContributions ?? undefined, context.signal);
            if (facts === null) { unavailableKeys.push(key); continue; }
            entries.push(facts);
        }
        if (context.signal.aborted) return { v: 1, status: 'cancelled' };
        if (!continuing && entries.length === 0) return { v: 1, status: 'unavailable', reason: 'noEntriesAvailable', unavailableKeys };
        if (!continuing && input.destination === 'single' && unavailableKeys.length > 0) {
            return { v: 1, status: 'unavailable', reason: 'singleEntryRequired', unavailableKeys };
        }
        const executionHost = {
            ...host,
            executeAction: (action: string, value: JsonValue, options?: Parameters<PluginUiHostApi['executeAction']>[2]) => host.executeAction(
                action, value, { ...options, signal: context.signal },
            ),
            selectActionInput: (request: Parameters<PluginUiHostApi['selectActionInput']>[0], options?: Parameters<PluginUiHostApi['selectActionInput']>[1]) => host.selectActionInput(
                request, { ...options, signal: context.signal },
            ),
        };
        const result = await runTriageConfiguredActionV1(executionHost, {
            actionId: input.actionId, destination: input.destination, entries, unavailableKeys,
            ...(continuing ? { selectedEntries: input.entries } : {}),
            ...(input.reviewChoices === undefined ? {} : { reviewChoices: input.reviewChoices }),
            ...(input.resumeReview === undefined ? {} : { resumeReview: input.resumeReview }),
            ...(input.resumeStart === undefined ? {} : { resumeStart: input.resumeStart }),
            ...(input.drafts === undefined ? {} : { settlements: entries.map((entry) => {
                const draft = input.drafts?.[input.destination === 'oneSessionForAllEntries' ? 0
                    : input.entries.findIndex((selected) => triageEntryRowKey(selected.entryRef) === entry.key)];
                return draft;
            }) }),
        }, { signal: context.signal });
        return TriageRunConfiguredActionResultV1Schema.parse(result);
    };
}

export function activate(api: PluginClientApi): void {
    api.actions.register(TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, createTriageRunConfiguredActionHandler());
}
