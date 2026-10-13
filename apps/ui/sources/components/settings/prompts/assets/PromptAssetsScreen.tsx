import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SkillFoundListResultV1Schema, SKILL_ACTION_OUTPUT_SCHEMAS_V1, type SkillFoundListResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useArtifacts } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { t } from '@/text';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

type FoundSkillItem = SkillFoundListResultV1['items'][number];
type FoundSkillsSnapshot = Readonly<{
    result: SkillFoundListResultV1;
    libraryScope: ReturnType<typeof useAccountSettingsScope>;
}>;

/** Temporary U10a consumer bridge; the Skills Found lane owns its replacement surface. */
export const PromptAssetsScreen = React.memo(function PromptAssetsScreen() {
    const router = useRouter();
    const artifacts = useArtifacts();
    const libraryScope = useAccountSettingsScope();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets);
    const selectedTarget = administrationTargetSelection.selectedTarget;
    const { selectionKey, resolveExactExecutionTarget, isExecutionTargetCurrent, isSelectionCurrent } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);
    const refreshGenerationRef = React.useRef(0);
    const [scope, setScope] = React.useState<'project' | 'user'>('project');
    const [found, setFound] = React.useState<FoundSkillsSnapshot | null>(null);
    const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);
    const { workspacePath: projectDirectory, setWorkspacePath: setProjectDirectory } = useContextBarSelection({
        selectionKey: 'promptAssets.externalAssets', defaultMachineId: null, defaultWorkspacePath: '', workspaceBindingKey: selectionKey,
    });

    React.useEffect(() => { refreshGenerationRef.current += 1; setFound(null); setHasLoadedOnce(false); },
        [selectionKey, scope, projectDirectory, libraryScope?.serverId, libraryScope?.accountId]);

    const refreshAssets = React.useCallback(async () => {
        const generation = ++refreshGenerationRef.current;
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) {
            if (generation !== refreshGenerationRef.current || !isSelectionCurrent(requestedSelection)) return;
            setFound(null); setHasLoadedOnce(true); return;
        }
        const directory = scope === 'project' ? projectDirectory.trim() : '';
        if (scope === 'project' && !directory) {
            setFound(null); setHasLoadedOnce(true); return;
        }
        const annotationScope = libraryScope && areServerProfileIdentifiersEquivalent(executionTarget.serverId, libraryScope.serverId)
            ? libraryScope : null;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const response = await createDefaultActionExecutor().execute('skills.found.list', {
            machineId: executionTarget.machine.id, ...(directory ? { directory } : {}),
        }, { surface: 'ui', serverId: executionTarget.serverId,
            ...(annotationScope ? { expectedAccountId: annotationScope.accountId } : {}),
            authority: 'present_user', actionCaller: { kind: 'host' } });
        if (generation !== refreshGenerationRef.current || !isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
        if (!response.ok) throw new Error(response.error);
        setFound({ result: SkillFoundListResultV1Schema.parse(response.result), libraryScope: annotationScope }); setHasLoadedOnce(true);
    }, [isExecutionTargetCurrent, isSelectionCurrent, libraryScope, projectDirectory, resolveExactExecutionTarget, scope, selectedTarget, selectionKey]);

    const [refreshing, runRefresh] = useHappyAction(refreshAssets, { mode: 'rerun_latest' });
    React.useEffect(() => { runRefresh(); }, [runRefresh, administrationTargetSelection.canExecute]);
    const artifactTitleById = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const artifact of artifacts) {
            const title = typeof artifact.header?.title === 'string' ? artifact.header.title : artifact.title;
            if (title) map.set(artifact.id, title);
        }
        return map;
    }, [artifacts]);

    const handleImport = React.useCallback(async (item: FoundSkillItem) => {
        if (!libraryScope) return;
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;
        if (item.scope === 'project' && !projectDirectory.trim()) {
            Modal.alert(t('common.error'), t('promptLibrary.externalAssetsProjectDirectoryRequired')); return;
        }
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const response = await createDefaultActionExecutor({ foundSkillSource: { target: executionTarget.target,
            isCurrent: () => isExecutionTargetCurrent(requestedSelection, executionTarget) } }).execute('skills.found.adopt', {
            machineId: executionTarget.machine.id, items: [{ name: item.name, path: item.path }],
        }, { surface: 'ui', serverId: libraryScope.serverId, expectedAccountId: libraryScope.accountId,
            authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!response.ok) { Modal.alert(t('common.error'), response.error); return; }
        const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(response.result);
        const skillId = receipt.skillIds[0];
        if (receipt.incomplete?.length) Modal.alert(t('common.error'), t('promptLibrary.saveError'));
        if (skillId && isExecutionTargetCurrent(requestedSelection, executionTarget)) {
            router.push(promptCollectionItemHref('bundle', skillId, { serverId: libraryScope.serverId }));
        }
    }, [isExecutionTargetCurrent, libraryScope, projectDirectory, resolveExactExecutionTarget, router, selectedTarget, selectionKey]);

    const executionTarget = resolveExactExecutionTarget(selectedTarget);

    return (
            <ItemList keyboardShouldPersistTaps="handled">
                <SettingsPageHeader
                    description={t('promptLibrary.surface.externalAssetsPageDescription')}
                    actions={(
                        <MachineAdministrationTargetSelector
                            selection={administrationTargetSelection}
                            presentation="chip"
                            testIDPrefix="settings.promptAssets.administration.target"
                        />
                    )}
                />
                <ItemGroup
                    title={t('promptLibrary.surface.whereToLookSection')}
                    description={t('promptLibrary.surface.whereToLookDescription')}
                    action={(
                        <SectionActionButton
                            testID="promptAssets.refresh"
                            title={t('common.refresh')}
                            icon="arrow-clockwise"
                            loading={refreshing}
                            disabled={refreshing || !administrationTargetSelection.canExecute}
                            onPress={runRefresh}
                        />
                    )}
                >
                    <SegmentedChoiceItem
                        title={t('promptLibrary.externalAssetsScope')}
                        options={[
                            { id: 'project', label: t('promptLibrary.externalAssetsProjectScope'), description: t('promptLibrary.externalAssetsProjectScopeSubtitle') },
                            { id: 'user', label: t('promptLibrary.externalAssetsUserScope'), description: t('promptLibrary.externalAssetsUserScopeSubtitle') },
                        ]}
                        value={scope}
                        onChange={(nextScope) => setScope(nextScope as 'project' | 'user')}
                    />
                    {scope === 'project' ? (
                        <ContextBar
                            mode="workspace_only"
                            workspace={{
                                value: projectDirectory,
                                onChange: setProjectDirectory,
                                placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
                                testID: 'promptAssets.directoryInput',
                                browse: {
                                    machineId: executionTarget?.machine.id ?? null,
                                    serverId: executionTarget?.serverId ?? null,
                                    enabled: administrationTargetSelection.canExecute,
                                },
                            }}
                        />
                    ) : null}
                </ItemGroup>

                {!hasLoadedOnce && refreshing ? (
                    <ItemGroup>
                        <Item
                            testID="promptAssets.loading"
                            title={t('common.loading')}
                            subtitle={t('promptLibrary.externalAssetsRefreshSubtitle')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}

                {(found?.result.roots ?? [])
                    .filter((entry) => scope === 'project' ? entry.scope === 'project' : entry.scope !== 'project')
                    .map((entry) => {
                        const root = entry.path.replace(/[\\/]+$/, '');
                        const items = found?.result.items.filter(item => item.scope === entry.scope
                            && (item.path.startsWith(`${root}/`) || item.path.startsWith(`${root}\\`))) ?? [];
                        return (
                            <ItemGroup key={entry.path} title={entry.path}>
                                {items.length > 0 ? (
                                    items.map((item, index) => (
                                        (() => {
                                            const linkedArtifact = item.inLibrary && found?.libraryScope
                                                && areAccountSettingsScopesEqual(found.libraryScope, libraryScope) ? { artifactId: item.inLibrary,
                                                title: artifactTitleById.get(item.inLibrary) ?? item.name } : null;
                                            const subtitle = linkedArtifact
                                                ? `${item.path} · ${t('promptLibrary.externalAssetsLinkedTo', { title: linkedArtifact.title })}`
                                                : item.path;
                                            return (
                                                <Item
                                                    key={`${item.path}:${index}`}
                                                    testID={`promptAssets.item.${scope}.${entry.path}.${index}`}
                                                    title={item.name}
                                                    subtitle={subtitle}
                                                    onPress={() => {
                                                        if (linkedArtifact) {
                                                            router.push(promptCollectionItemHref('bundle', linkedArtifact.artifactId, { serverId: libraryScope?.serverId }));
                                                            return;
                                                        }
                                                        void handleImport(item).catch(() => Modal.alert(t('common.error'), t('promptLibrary.saveError')));
                                                    }}
                                                    rightElement={(
                                                        <ItemRowActions
                                                            title={item.name}
                                                            compactActionIds={linkedArtifact ? ['open'] : ['import']}
                                                            actions={linkedArtifact ? [
                                                                {
                                                                    id: 'open',
                                                                    title: t('common.open'),
                                                                    icon: 'arrow-square-out',
                                                                    onPress: () => router.push(promptCollectionItemHref('bundle', linkedArtifact.artifactId, { serverId: libraryScope?.serverId })),
                                                                },
                                                            ] : [
                                                                {
                                                                    id: 'import',
                                                                    title: t('promptLibrary.externalAssetsImportAction'),
                                                                    icon: 'download',
                                                                    onPress: () => { void handleImport(item).catch(() => Modal.alert(t('common.error'), t('promptLibrary.saveError'))); },
                                                                },
                                                            ]}
                                                        />
                                                    )}
                                                />
                                            );
                                        })()
                                    ))
                                ) : (
                                    <Item
                                        testID={`promptAssets.empty.${scope}.${entry.path}`}
                                        title={t('promptLibrary.externalAssetsNoItems')}
                                        subtitle={t('promptLibrary.externalAssetsNoItemsSubtitle')}
                                        mode="info"
                                        showChevron={false}
                                    />
                                )}
                            </ItemGroup>
                        );
                    })}
            </ItemList>
    );
});
