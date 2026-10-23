import * as React from 'react';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows';
import type { BuiltinWorkflowPurposeV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { WorkflowDefinitionArtifactHeaderV1ReadSchema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceV1';
import { useShallow } from 'zustand/react/shallow';

import { useWorkflowDefinitionLibrary } from '@/components/workflows/library/workflowLibraryReads';
import { captureDaemonMergedProjectionReader } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getStorage, useActiveServerAccountScopeLifetime, useSetting } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { t } from '@/text';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from './workflowProblemPresentation';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** A workflow a Run a workflow step can name, as the picker and the block both present it. */
export type WorkflowReferenceOption = Readonly<{
    ref: string;
    title: string;
    /** "Built-in" for catalog workflows; absent for the person's own. */
    origin?: 'builtin';
    purpose?: BuiltinWorkflowPurposeV1;
    unavailableReason?: string;
}>;

/** The built-in workflows, named by their catalog titles. */
export function listBuiltinWorkflowReferenceOptions(): readonly WorkflowReferenceOption[] {
    return getBuiltinWorkflowCatalogV1().map((entry) => ({ ref: entry.id, title: t(entry.titleKey as never), origin: 'builtin', purpose: entry.purpose }));
}

/**
 * Names for already-admitted references, not an options/catalog demand. The trigger reader has
 * resolved its targets before publishing rows; saved headers and plugin contributions are already
 * in their canonical stores. Missing/revoked/locked facts stay missing rather than starting reads.
 */
export function useWorkflowReferenceTitles(refs: readonly string[], enabled = true): (ref: string) => string | null {
    const lifetime = useActiveServerAccountScopeLifetime();
    const language = useSetting('preferredLanguage');
    const requested = React.useMemo(() => refs.map(ref => ({ ref, parsed: parseWorkflowDefinitionRefV1(ref) })), [refs]);
    const artifactIds = React.useMemo(() => requested.flatMap(({ parsed }) => parsed?.kind === 'artifact' ? [parsed.artifactId] : []), [requested]);
    const pluginsEnabled = enabled && requested.some(({ parsed }) => parsed?.kind === 'plugin');
    const useStore = getStorage();
    const headers = useStore(useShallow(state => artifactIds.map(id => {
        const artifact = state.artifacts[id];
        return enabled && lifetime?.isCurrent() && areAccountSettingsScopesEqual(state.settingsScope, lifetime.scope)
            && artifact?.isDecrypted && artifact.ownerAccountId && artifact.access ? artifact.rawHeader ?? null : null;
    })));
    const machineInputs = useStore(useShallow(state => pluginsEnabled && lifetime?.isCurrent()
        && areAccountSettingsScopesEqual(state.settingsScope, lifetime.scope)
        ? [state.machines, state.machineListByServerId, state.machineListStatusByServerId] as const : null));
    const reachabilityRevision = useMachineReachabilityRevision(pluginsEnabled);
    const pluginRefs = React.useMemo(() => new Set(requested.flatMap(({ ref, parsed }) => parsed?.kind === 'plugin' ? [ref] : [])), [requested]);
    const readers = React.useMemo(() => {
        if (!machineInputs || !lifetime?.isCurrent()) return [];
        const relay = resolveUiAccountActionFallbackMachineId(lifetime.scope);
        const machines = resolveVisibleMachinesForActiveServerFromState(useStore.getState(), lifetime.scope);
        // The current relay names its references first; a still-visible admitted source retains
        // inert labels while a replacement relay has not supplied those references yet.
        const ordered = [...machines.filter(machine => machine.id === relay), ...machines.filter(machine => machine.id !== relay)];
        return ordered.map(machine => ({ relay: machine.id === relay,
            reader: captureDaemonMergedProjectionReader({ machineId: machine.id, serverId: lifetime.scope.serverId }) }));
    }, [lifetime, machineInputs, reachabilityRevision, useStore]);
    const readAdmitted = React.useCallback((reader: ReturnType<typeof captureDaemonMergedProjectionReader>) => {
        const entry = reader.readCached();
        return lifetime?.isCurrent() && entry?.accountCurrentness?.isCurrent()
            && areServerAccountScopesEqual(entry.accountScope ?? null, lifetime.scope)
            && (entry.kind === 'ready' || entry.kind === 'error') && entry.inputs
            ? entry.inputs : null;
    }, [lifetime]);
    const hasRequestedPlugin = React.useCallback((inputs: ReturnType<typeof readAdmitted>) =>
        Object.values(inputs?.pluginProjectionV2?.familiesById.workflows?.entriesById ?? {}).some(workflow => workflow.pluginId
            && pluginRefs.has(projectWorkflowPluginSourceV1({ pluginId: workflow.pluginId,
                pluginVersion: workflow.pluginVersion, definition: workflow.definition }).workflow)), [pluginRefs]);
    const selectTitles = useShallow(React.useCallback(() => {
        const titles = new Map<string, string>();
        for (const { reader } of readers) {
            const inputs = readAdmitted(reader);
            for (const workflow of Object.values(inputs?.pluginProjectionV2?.familiesById.workflows?.entriesById ?? {})) {
                if (!workflow.pluginId) continue;
                const source = projectWorkflowPluginSourceV1({ pluginId: workflow.pluginId,
                    pluginVersion: workflow.pluginVersion, definition: workflow.definition });
                if (pluginRefs.has(source.workflow) && !titles.has(source.workflow)) titles.set(source.workflow, source.title);
            }
        }
        return [...pluginRefs].map(ref => titles.get(ref) ?? null);
    }, [pluginRefs, readAdmitted, readers]));
    const readTitles = React.useCallback(() => selectTitles(undefined), [selectTitles]);
    const subscribeInputs = React.useCallback((notify: () => void) => {
        // Empty/unrelated fleet snapshots do not become subscriptions. The relay is observed even
        // before its answer exists; retained sources are observed only for the visible exact refs.
        const stops = readers.filter(({ relay, reader }) => relay || hasRequestedPlugin(readAdmitted(reader)))
            .map(({ reader }) => reader.subscribeSummary(notify));
        return () => { for (const stop of stops) stop(); };
    }, [hasRequestedPlugin, readAdmitted, readers]);
    const pluginTitles = React.useSyncExternalStore(subscribeInputs, readTitles, readTitles);
    const titles = React.useMemo(() => {
        const result = new Map(listBuiltinWorkflowReferenceOptions().map(option => [option.ref, option.title]));
        artifactIds.forEach((id, index) => {
            const header = headers[index];
            if (header?.kind !== 'workflow-definition.v1') return;
            // Match the library's unavailable-content display contract: validated metadata remains
            // useful even when the definition body or its revision cannot be opened.
            const metadata = WorkflowDefinitionArtifactHeaderV1ReadSchema.shape.metadata.safeParse(header.metadata);
            result.set(id, formatWorkflowDefinitionLibraryTitle({ metadata: metadata.success ? metadata.data : null }));
        });
        if (pluginsEnabled && lifetime?.isCurrent()) {
            [...pluginRefs].forEach((ref, index) => {
                const title = pluginTitles[index];
                if (title !== undefined && title !== null) result.set(ref, title);
            });
        }
        return result;
    }, [artifactIds, headers, language, lifetime, pluginTitles, pluginRefs, pluginsEnabled]);
    return React.useCallback(ref => titles.get(ref) ?? null, [titles]);
}

/**
 * The person's own saved workflows as references, from the library owner's one
 * read. Mounted only where it is demanded (an open Run a workflow picker, or a
 * block that names a saved workflow), so an editor without either reads nothing.
 */
export function useWorkflowLibraryReferenceOptions(options?: Readonly<{ enabled?: boolean; accountLifetime?: ServerAccountScopeLifetime | null }>): readonly WorkflowReferenceOption[] {
    return useWorkflowReferenceLibrary(options).options;
}

/** Reference presentation borrows pagination/retry from the one library reader. */
export function useWorkflowReferenceLibrary(options?: Readonly<{ enabled?: boolean; accountLifetime?: ServerAccountScopeLifetime | null }>) {
    const library = useWorkflowDefinitionLibrary(options);
    const references = React.useMemo(
        (): readonly WorkflowReferenceOption[] => [
            ...library.definitions.map((definition) => ({ ref: definition.definitionId, title: formatWorkflowDefinitionLibraryTitle(definition),
                ...(definition.contentStatus === 'unavailable'
                    ? { unavailableReason: formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) } : {}) })),
            ...library.pluginWorkflows.map((source) => ({ ref: source.workflow, title: source.title })),
        ],
        [library.definitions, library.pluginWorkflows],
    );
    return { ...library, options: references };
}
