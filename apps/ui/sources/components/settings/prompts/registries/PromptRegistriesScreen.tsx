import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistrySourceMutations } from '@/registries/useRegistrySourceMutations';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionRoutes';
import { importPromptRegistrySkillItem } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { t } from '@/text';
import { buildPromptRegistryItemDetailsHref } from './promptRegistryItemDetailsHref';

const styles = StyleSheet.create(() => ({
  addSourceFields: {
    gap: 12,
  },
}));

/** Retained 0.2 route presentation; registry data and installs flow through the canonical Actions. */
export const PromptRegistriesScreen = React.memo(function PromptRegistriesScreen() {
  const router = useRouter();
  const libraryScope = useAccountSettingsScope();
  const execution = useMountedActionExecution(libraryScope);
  const administrationTargetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries);
  const selectedTarget = administrationTargetSelection.selectedTarget;
  const { selectionKey, resolveExactExecutionTarget } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);
  const { workspacePath, setWorkspacePath } = useContextBarSelection({ selectionKey: 'promptRegistries.browse',
    defaultMachineId: null, workspaceBindingKey: selectionKey });
  const sourceRead = useRegistrySources('skill');
  const sources = sourceRead.sources;
  const mutations = useRegistrySourceMutations();
  const [selectedSourceId, setSelectedSourceId] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [submittedQuery, setSubmittedQuery] = React.useState('');
  const [isAddGitSourceOpen, setIsAddGitSourceOpen] = React.useState(false);
  const [sourceTitle, setSourceTitle] = React.useState('');
  const [sourceUrl, setSourceUrl] = React.useState('');
  const browse = useRegistryItems({ kind: 'skill', sourceIds: selectedSourceId ? [selectedSourceId] : [], query: submittedQuery });
  const items = browse.items;
  const hasLoadedOnce = sourceRead.status === 'ready';

  React.useEffect(() => {
    setSelectedSourceId(current => sources.some(source => source.id === current) ? current : sources.find(source => source.enabled)?.id ?? null);
  }, [sources]);
  const registryError = sourceRead.error ?? browse.error ?? browse.sourceFailures[0]?.message;
  React.useEffect(() => {
    if (registryError) Modal.alert(t('common.error'), translatePromptLibraryMessage(registryError));
  }, [registryError]);

  const scanSource = React.useCallback(async (sourceId: string, query?: string | null) => {
    setSelectedSourceId(sourceId);
    setSubmittedQuery(query?.trim() ?? '');
  }, []);
  const refreshSources = React.useCallback(async () => { await sourceRead.refresh(); await browse.refresh(); },
    [sourceRead.refresh, browse.refresh]);
  const [refreshingAction, runRefresh] = useHappyAction(refreshSources);
  const refreshing = refreshingAction || sourceRead.loading;

  const addGitSource = React.useCallback(async () => {
    const title = sourceTitle.trim(), url = sourceUrl.trim();
    if (!title || !url) { Modal.alert(t('common.error'), t('promptLibrary.registriesAddGitSourceError')); return; }
    try { await mutations.create({ title, url }); }
    catch { Modal.alert(t('common.error'), t('errors.unknownError')); return; }
    setSourceTitle(''); setSourceUrl(''); setIsAddGitSourceOpen(false);
  }, [mutations.create, sourceTitle, sourceUrl]);
  const removeSource = React.useCallback(async (sourceId: string) => {
    try { await mutations.delete(sourceId); }
    catch { Modal.alert(t('common.error'), t('errors.unknownError')); }
  }, [mutations.delete]);
  const importItem = React.useCallback(async (item: RegistryItemSummaryV1) => {
    if (!libraryScope) return;
    const imported = await importPromptRegistrySkillItem({ sourceId: item.sourceId, itemId: item.itemId,
      ...(item.version ? { version: item.version } : {}),
      serverId: libraryScope.serverId, expectedAccountId: libraryScope.accountId }, execution.execute);
    if (!imported.ok) { Modal.alert(t('common.error'), translatePromptLibraryMessage(imported.error)); return; }
    if (!execution.isCurrent()) return;
    router.push(promptCollectionItemHref('bundle', imported.artifactId, { serverId: libraryScope.serverId }));
  }, [execution.execute, execution.isCurrent, libraryScope, router]);
  const openItemDetails = React.useCallback((item: RegistryItemSummaryV1) => {
    router.push(buildPromptRegistryItemDetailsHref({ item, workspacePath }));
  }, [router, workspacePath]);
  const searchSelectedSource = React.useCallback(async () => {
    setSubmittedQuery(searchQuery.trim());
    if (submittedQuery === searchQuery.trim()) await browse.refresh();
  }, [browse.refresh, searchQuery, submittedQuery]);
  const [searching, runSearchSelectedSource] = useHappyAction(searchSelectedSource);
  const executionTarget = resolveExactExecutionTarget(selectedTarget);

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <SettingsPageHeader
        description={t('promptLibrary.surface.registriesPageDescription')}
        actions={(
          <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            presentation="chip"
            testIDPrefix="settings.promptRegistries.administration.target"
          />
        )}
      />
      <ItemGroup title={t('promptLibrary.surface.projectSection')} description={t('promptLibrary.surface.registriesProjectDescription')}>
        <ContextBar
          mode="workspace_only"
          workspace={{
            value: workspacePath,
            onChange: setWorkspacePath,
            placeholder: t('promptLibrary.surface.projectDirectoryPlaceholder'),
            testID: 'promptRegistries.workspacePath',
            browse: {
              machineId: executionTarget?.machine.id ?? null,
              serverId: executionTarget?.serverId ?? null,
              enabled: administrationTargetSelection.canExecute,
            },
          }}
        />
      </ItemGroup>

      <ItemGroup
        title={t('promptLibrary.registriesSources')}
        description={t('promptLibrary.surface.registriesSourcesDescription')}
        action={(
          <SectionActionButton
            testID="promptRegistries.refresh"
            title={t('common.refresh')}
            icon="arrow-clockwise"
            loading={refreshing}
            disabled={refreshing}
            onPress={runRefresh}
          />
        )}
      >
        {!hasLoadedOnce && refreshing ? (
          <Item
            testID="promptRegistries.loading"
            title={t('common.loading')}
            subtitle={t('promptLibrary.registriesRefreshSubtitle')}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {sources.length > 0 ? sources.map((source, index) => (
          <Item
            key={source.id}
            testID={`promptRegistries.source.${index}`}
            title={source.title}
            subtitle={source.url || source.id}
            selected={source.id === selectedSourceId}
            onPress={() => void scanSource(source.id)}
            rightElement={source.origin.kind === 'user' ? (
              <ItemRowActions
                title={source.title}
                compactActionIds={['delete']}
                actions={[
                  {
                    id: 'delete',
                    title: t('common.delete'),
                    icon: 'trash',
                    destructive: true,
                    onPress: () => removeSource(source.id),
                  },
                ]}
              />
            ) : undefined}
          />
        )) : hasLoadedOnce || !refreshing ? (
          <Item
            testID="promptRegistries.sources.empty"
            title={t('promptLibrary.registriesNoSources')}
            subtitle={t('promptLibrary.registriesNoSourcesSubtitle')}
            mode="info"
            showChevron={false}
          />
        ) : null}
        <InlineAddExpander
          isOpen={isAddGitSourceOpen}
          onOpenChange={setIsAddGitSourceOpen}
          triggerTestID="promptRegistries.addGitSource"
          title={t('promptLibrary.registriesAddGitSource')}
          subtitle={t('promptLibrary.registriesAddGitSourceSubtitle')}
          onCancel={() => {
            setSourceTitle('');
            setSourceUrl('');
            setIsAddGitSourceOpen(false);
          }}
          onSave={addGitSource}
          saveDisabled={sourceTitle.trim().length === 0 || sourceUrl.trim().length === 0}
          cancelLabel={t('common.cancel')}
          saveLabel={t('common.save')}
        >
          <View style={styles.addSourceFields}>
            <FieldTextInput
              testID="promptRegistries.sourceTitle"
              accessibilityLabel={t('promptLibrary.registriesSourceTitleLabel')}
              placeholder={t('promptLibrary.registriesSourceTitlePlaceholder')}
              value={sourceTitle}
              onChangeText={setSourceTitle}
            />
            <FieldTextInput
              testID="promptRegistries.sourceUrl"
              accessibilityLabel={t('promptLibrary.registriesSourceUrlLabel')}
              placeholder={t('promptLibrary.registriesSourceUrlPlaceholder')}
              value={sourceUrl}
              onChangeText={setSourceUrl}
              autoCapitalize="none"
              monospace
            />
          </View>
        </InlineAddExpander>
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.registriesItems')} description={t('promptLibrary.surface.registriesItemsDescription')}>
        <Item
          title={t('promptLibrary.registriesSearchLabel')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptRegistries.searchQuery"
              accessibilityLabel={t('promptLibrary.registriesSearchLabel')}
              placeholder={t('promptLibrary.registriesSearchPlaceholder')}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={runSearchSelectedSource}
              autoCapitalize="none"
              returnKeyType="search"
            />
          )}
        />
        {items.length > 0 ? items.map((item, index) => (
          <Item
            key={item.itemId}
            testID={`promptRegistries.item.${index}`}
            title={item.title}
            subtitle={item.description || item.itemId}
            onPress={() => openItemDetails(item)}
            rightElement={(
              <ItemRowActions
                title={item.title}
                compactActionIds={['details', 'import']}
                actions={[
                  {
                    id: 'details',
                    title: t('common.details'),
                    icon: 'eye',
                    onPress: () => openItemDetails(item),
                  },
                  {
                    id: 'import',
                    title: t('promptLibrary.externalAssetsImportAction'),
                    icon: 'download',
                    disabled: searching,
                    onPress: () => { void importItem(item); },
                  },
                ]}
              />
            )}
          />
        )) : (
          <Item
            testID="promptRegistries.items.empty"
            title={t('promptLibrary.registriesNoItems')}
            subtitle={t('promptLibrary.registriesNoItemsSubtitle')}
            mode="info"
            showChevron={false}
          />
        )}
      </ItemGroup>
    </ItemList>
  );
});
