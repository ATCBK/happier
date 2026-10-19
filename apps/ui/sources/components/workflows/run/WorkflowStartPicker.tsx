import * as React from 'react';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { workflowInputTitle, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { SelectionList, type SelectionListDynamicSectionResolveResult, type SelectionListStep } from '@/components/ui/selectionList';
import { SelectionListSectionFailure } from '@/components/ui/selectionList/selectionListSectionFailure';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t, tLoose } from '@/text';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';
import { listWorkflowPersonInputs, resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * Two panes (lab T4-R): the list, and beside it what the highlighted pattern does and asks for. The Run…
 * chip (`createWorkflowRunActionChip`) gives the popover the width; narrower, the list stands alone.
 */
const PICKER_DETAIL_PANE = Object.freeze({ minListWidthPx: 560, widthPx: 320 });

/** Holds a library read open until the section's next resolver (a library state change) aborts it. */
function untilAborted(signal: AbortSignal): Promise<SelectionListDynamicSectionResolveResult> {
    return new Promise((resolve) => {
        if (signal.aborted) resolve({ options: [] });
        else signal.addEventListener('abort', () => resolve({ options: [] }), { once: true });
    });
}

const styles = StyleSheet.create((theme) => ({
    preview: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12, gap: theme.space.s12 },
    previewHead: { gap: theme.space.s4 },
    previewTitle: { ...Typography.variant('heading'), color: theme.colors.text.primary },
    previewBody: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    previewLabel: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary },
    previewSection: { gap: theme.space.s4 },
    previewStep: { flexDirection: 'row', gap: theme.space.s8 },
    previewOrdinal: { ...Typography.variant('meta'), ...Typography.tabular(), color: theme.colors.text.tertiary, minWidth: theme.space.s12 },
    previewStepName: { ...Typography.variant('body'), color: theme.colors.text.primary, flexShrink: 1 },
    previewMeta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));

/** The highlighted pattern itself: what it does, the steps it takes, and what it asks for. */
function WorkflowStartPreview(props: Readonly<{ selection: WorkflowStartSelection }>) {
    const { definition } = props.selection;
    const presentation = resolveWorkflowBuiltinInputPresentation(props.selection.id);
    const inputs = listWorkflowPersonInputs(definition.inputs)
        .map((input) => presentation?.[input.name]?.title ?? workflowInputTitle(input));
    return <ScrollView testID={`workflow-start-preview:${props.selection.id}`} contentContainerStyle={styles.preview}>
        <View style={styles.previewHead}>
            <Text style={styles.previewTitle}>{props.selection.name}</Text>
            {props.selection.description ? <Text style={styles.previewBody}>{props.selection.description}</Text> : null}
        </View>
        {definition.blocks.length === 0 ? null : <View style={styles.previewSection}>
            <Text style={styles.previewLabel}>{t('workflows.tabs.steps')}</Text>
            {definition.blocks.map((block, index) => <View key={block.id} style={styles.previewStep}>
                <Text style={styles.previewOrdinal}>{index + 1}</Text>
                <Text style={styles.previewStepName}>{workflowBlockReferenceLabel(block, t('workflows.start.workflow'))}</Text>
            </View>)}
        </View>}
        {inputs.length === 0 ? <Text style={styles.previewMeta}>{t('workflows.start.noInputs')}</Text> : <View style={styles.previewSection}>
            <Text style={styles.previewLabel}>{t('workflows.start.inputs')}</Text>
            <Text style={styles.previewStepName}>{inputs.join(' · ')}</Text>
        </View>}
    </ScrollView>;
}

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
    // "Load more" belongs under rows the person has seen, never under the first page's skeletons.
    const [libraryShown, setLibraryShown] = React.useState(false);
    // "Your library" is always a section: skeletons while the first page reads, its own failure line with
    // Retry, or the empty sentence. A Retry on that line re-reads the library, never only this section.
    const libraryRef = React.useRef(library);
    libraryRef.current = library;
    const shownFailureRef = React.useRef<typeof library.failure>(null);
    const libraryPhase = library.definitions.length > 0 ? 'rows' : library.status;
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
        const asked = listWorkflowPersonInputs(definition.inputs);
        return asked.length === 0 ? t('workflows.start.noInputs')
            : t('workflows.start.asksFor', { names: asked
                .map(input => presentation?.[input.name]?.title ?? workflowInputTitle(input)).join(', ') });
    }, []);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'workflow-start-picker', inputPlaceholder: t('workflows.start.search'),
        sections: [
            { kind: 'static', id: 'builtins', title: t('workflows.start.builtin'), options: builtinSelections.map((entry) => {
            // What it does helps choose; what it asks for is shown once it is chosen.
            const needsSession = props.hasOriginSession !== true
                && BUILTIN_WORKFLOW_CATALOG_V1.find((candidate) => candidate.id === entry.id)?.requiresOriginSession === true;
            return {
                // An unavailable pattern says why in place of what it does; the reason is the line that matters here.
                id: entry.id, label: entry.name,
                subtitle: needsSession ? t('workflows.start.needsSession') : entry.description || asks(entry.definition, entry.id),
                testID: `workflow-choice:${entry.id}`,
                detailContent: () => <WorkflowStartPreview selection={entry} />,
                disabled: needsSession,
            }; }) },
            { kind: 'dynamic', id: 'library', title: t('workflows.start.library'),
                resolverKey: JSON.stringify([libraryPhase, ...library.definitions.map((entry) => [entry.definitionId, entry.revision, entry.contentStatus,
                    entry.contentStatus === 'unavailable' ? entry.contentUnavailableReason : null])]),
                showSkeletonsOnFirstLoad: true,
                loadingSkeletonRows: 2,
                retryLabel: t('common.retry'),
                resolve: async (query, signal) => {
                    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
                    if (lifetime === null || !lifetime.isCurrent()) return { options: [] };
                    const current = libraryRef.current;
                    if (current.definitions.length === 0 && current.status === 'failed' && current.failure) {
                        if (shownFailureRef.current !== current.failure) {
                            shownFailureRef.current = current.failure;
                            throw new SelectionListSectionFailure({ hint: current.failure.message });
                        }
                        // Retry pressed on the failure line already shown: read the library again.
                        current.retry();
                        return untilAborted(signal);
                    }
                    if (current.definitions.length === 0 && current.status !== 'loaded') return untilAborted(signal);
                    if (current.definitions.length === 0) return { options: [], emptyHint: t('workflows.destination.libraryEmpty') };
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
                        return { option: { id: selection.id, label: selection.name, subtitle: selection.description || asks(selection.definition),
                            detailContent: () => <WorkflowStartPreview selection={selection} /> }, selection };
                    }));
                    if (signal.aborted || !lifetime.isCurrent()) return { options: [] };
                    setLibraryShown(true);
                    savedSelections.current = new Map(rows.flatMap((entry) => entry.selection === null ? []
                        : [[entry.selection.id, { selection: entry.selection, lifetime }] as const]));
                    return { options: rows.map((entry) => entry.option) };
                },
            },
            { kind: 'static', id: 'plugins', title: t('workflows.plugins.fromPlugins'), options: pluginSelections.map((entry) => ({
                id: entry.id, label: entry.name, subtitle: entry.description || asks(entry.definition, entry.id), testID: `workflow-choice:${entry.id}`,
                detailContent: () => <WorkflowStartPreview selection={entry} />,
            })) },
        ],
    }), [accountLifetime, asks, builtinSelections, library.definitions, libraryPhase, pluginSelections, props.hasOriginSession]);
    return <View>
        {/* A fixed viewport: the library landing never moves the popover or its search field (lab T4-R). */}
        <SelectionList rootStep={rootStep} maxHeight={props.maxHeight} heightBehavior="fixedToMaxHeight" autoFocusInputOnWeb
            detailPane={PICKER_DETAIL_PANE}
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
        {library.hasMore && libraryShown ? <RoundButton size="small" display="inverted" title={t('workflows.destination.loadMoreWorkflows')}
            loading={library.loadingMore} onPress={library.loadMore} /> : null}
    </View>;
}
