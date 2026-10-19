import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { workflowInputTitle, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { View } from 'react-native';
import { t, tLoose } from '@/text';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';
import { resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type WorkflowStartSelection = Readonly<{
    id: string;
    name: string;
    description: string;
    definition: WorkflowDefinitionV1;
    source: WorkflowRunStartRequestV1['source'];
}>;

/** Only mounted while the Workflow chip is open; FIN owns the Account library and exact reads. */
export function WorkflowStartPicker(props: Readonly<{
    onSelect: (selection: WorkflowStartSelection) => void;
    onRequestClose: () => void;
    maxHeight: number;
    /** Opened inside a Session: built-ins that run in their origin Session become startable. */
    hasOriginSession?: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): React.ReactElement {
    const accountLifetime = useWorkflowAccountLifetime(props.accountLifetime);
    const library = useWorkflowDefinitionLibrary({ accountLifetime });
    const savedSelections = React.useRef(new Map<string, Readonly<{
        selection: WorkflowStartSelection;
        lifetime: NonNullable<ReturnType<typeof captureActiveServerAccountScopeLifetime>>;
    }>>());
    const builtinSelections = React.useMemo(() => BUILTIN_WORKFLOW_CATALOG_V1.map((entry): WorkflowStartSelection => ({
        id: entry.id, name: tLoose(entry.titleKey), description: tLoose(entry.descriptionKey),
        definition: entry.definition, source: { kind: 'catalog', workflow: entry.id },
    })), []);
    const pluginSelections = React.useMemo(() => library.pluginWorkflows.map((entry): WorkflowStartSelection => ({
        id: entry.workflow, name: entry.title, description: entry.description ?? '', definition: entry.definition,
        source: { kind: 'catalog', workflow: entry.workflow, pluginVersion: entry.version },
    })), [library.pluginWorkflows]);
    const asks = React.useCallback((definition: WorkflowDefinitionV1, workflowRef?: string) => {
        const presentation = resolveWorkflowBuiltinInputPresentation(workflowRef);
        return definition.inputs.length === 0 ? t('workflows.start.noInputs')
            : t('workflows.start.asksFor', { names: definition.inputs
                .map(input => presentation?.[input.name]?.title ?? workflowInputTitle(input)).join(', ') });
    }, []);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'workflow-start-picker', inputPlaceholder: t('workflows.start.search'),
        sections: [
            { kind: 'static', id: 'builtins', title: t('workflows.start.builtin'), options: builtinSelections.map((entry) => ({
                // What it does helps choose; what it asks for is shown once it is chosen.
                id: entry.id, label: entry.name, subtitle: entry.description || asks(entry.definition, entry.id),
                testID: `workflow-choice:${entry.id}`,
                disabled: props.hasOriginSession !== true
                    && BUILTIN_WORKFLOW_CATALOG_V1.find((candidate) => candidate.id === entry.id)?.requiresOriginSession,
            })) },
            { kind: 'dynamic', id: 'library', title: t('workflows.start.library'),
                resolverKey: JSON.stringify(library.definitions.map((entry) => [entry.definitionId, entry.revision, entry.contentStatus,
                    entry.contentStatus === 'unavailable' ? entry.contentUnavailableReason : null])),
                showSkeletonsOnFirstLoad: true,
                resolve: async (query, signal) => {
                    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
                    if (lifetime === null || !lifetime.isCurrent()) return { options: [] };
                    // Hydrate only the matching loaded page, through FIN's exact read. No second catalog/cache.
                    const rows = await Promise.all(library.definitions.filter((entry) =>
                        formatWorkflowDefinitionLibraryTitle(entry).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                    ).map(async (header) => {
                        if (header.contentStatus === 'unavailable') return {
                            option: { id: header.definitionId, label: formatWorkflowDefinitionLibraryTitle(header),
                                subtitle: formatWorkflowDefinitionContentUnavailableReason(header.contentUnavailableReason), disabled: true },
                            selection: null,
                        };
                        const result = await getWorkflowDefinition({ definitionId: header.definitionId, signal, accountLifetime: lifetime });
                        const selection = {
                            id: result.definitionId, name: result.metadata.title, description: result.metadata.description ?? '',
                            definition: result.definition,
                            source: { kind: 'saved', definitionId: result.definitionId, revision: result.revision },
                        } satisfies WorkflowStartSelection;
                        return { option: { id: selection.id, label: selection.name, subtitle: selection.description || asks(selection.definition) }, selection };
                    }));
                    if (signal.aborted || !lifetime.isCurrent()) return { options: [] };
                    savedSelections.current = new Map(rows.flatMap((entry) => entry.selection === null ? []
                        : [[entry.selection.id, { selection: entry.selection, lifetime }] as const]));
                    return { options: rows.map((entry) => entry.option) };
                },
            },
            { kind: 'static', id: 'plugins', title: t('workflows.plugins.fromPlugins'), options: pluginSelections.map((entry) => ({
                id: entry.id, label: entry.name, subtitle: entry.description || asks(entry.definition, entry.id), testID: `workflow-choice:${entry.id}`,
            })) },
        ],
    }), [accountLifetime, asks, builtinSelections, library.definitions, pluginSelections, props.hasOriginSession]);
    return <View>
        <SelectionList rootStep={rootStep} maxHeight={props.maxHeight} heightBehavior="content" autoFocusInputOnWeb
            onSelect={(id) => {
                const saved = savedSelections.current.get(id);
                const selection = builtinSelections.find((entry) => entry.id === id)
                    ?? pluginSelections.find((entry) => entry.id === id)
                    ?? (saved?.lifetime.isCurrent() && library.definitions.some((entry) => entry.definitionId === id && entry.contentStatus === 'available')
                        ? saved.selection : undefined);
                if (!selection) return;
                props.onSelect(selection);
                props.onRequestClose();
            }} onRequestClose={props.onRequestClose} />
        {library.failure ? <RoundButton size="small" display="inverted" title={t('common.retry')} onPress={library.retry} /> : null}
        {library.hasMore ? <RoundButton size="small" display="inverted" title={t('workflows.destination.loadMoreWorkflows')}
            loading={library.loadingMore} onPress={library.loadMore} /> : null}
    </View>;
}
