import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    type McpServerRuleV1,
    type McpServerCatalogEntryTransportV1,
    type McpServerCatalogEntryV1,
} from '@happier-dev/protocol';
import { reachPlaceKeyV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import { applyMcpServerConfigOverrideV1 } from '@happier-dev/protocol/mcp/servers/resolveMcpServerConfigForContextV1';

import { McpServerBindingEditor } from '@/components/settings/mcpServers/McpServerBindingEditor';
import { McpServerBindingDraftExpander } from '@/components/settings/mcpServers/McpServerBindingDraftExpander';
import { McpServerTestPanel } from '@/components/settings/mcpServers/McpServerTestPanel';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { StringListField } from '@/components/ui/forms/StringListField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';

/**
 * The sections of one MCP server's editor: what it is called, how Happier starts or reaches it, the
 * values it receives, where it applies (each rule expands in place; a new rule is a draft row), and a
 * test against the managed machine. Saving and deleting belong to the page header.
 */
export const McpServerConfigureForm = React.memo(function McpServerConfigureForm(props: Readonly<{
    draftServer: McpServerCatalogEntryV1;
    draftBindings: McpServerRuleV1[];
    machines: readonly Machine[];
    targetSelection: MachineAdministrationTargetSelectionV1;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    onChangeServer: (updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
    onChangeBindings: (updater: (current: McpServerRuleV1[]) => McpServerRuleV1[]) => void;
}>) {
    const [favoriteDirectoriesRaw, setFavoriteDirectoriesRaw] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = Array.isArray(favoriteDirectoriesRaw) ? favoriteDirectoriesRaw : [];
    const { onChangeServer } = props;

    return (
        <>
            <ItemGroup title={t('mcpSettings.serverSection')} description={t('mcpSettings.serverSectionDescription')}>
                <Item
                    title={t('settings.mcpServersFieldName')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="mcp.server.editor.name"
                            value={props.draftServer.name}
                            onChangeText={(text) => onChangeServer((current) => ({ ...current, name: text, updatedAt: Date.now() }))}
                            accessibilityLabel={t('settings.mcpServersFieldName')}
                            placeholder="my_server"
                            monospace
                        />
                    )}
                />
                <Item
                    title={t('settings.mcpServersFieldTitle')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="mcp.server.editor.title"
                            value={props.draftServer.title ?? ''}
                            onChangeText={(text) => onChangeServer((current) => ({
                                ...current,
                                title: text.trim() ? text : undefined,
                                updatedAt: Date.now(),
                            }))}
                            accessibilityLabel={t('settings.mcpServersFieldTitle')}
                            placeholder={t('settings.mcpServersFieldTitlePlaceholder')}
                            autoCapitalize="words"
                        />
                    )}
                />
            </ItemGroup>

            <McpServerConfigurationSection
                draftServer={props.draftServer}
                secrets={props.secrets}
                scope={props.scope}
                mode="create"
                onChangeServer={onChangeServer}
            />

            <ItemGroup title={t('settings.mcpServersEditorAppliesTo')} description={t('settings.mcpServersEditorAppliesToSubtitle')}>
                {props.draftBindings.map((binding) => (
                    <McpServerBindingEditor
                        key={binding.id}
                        binding={binding}
                        configOverride={props.draftServer.configOverrides?.find(override => reachPlaceKeyV1(override.target) === reachPlaceKeyV1(binding.target))}
                        serverTransport={props.draftServer.transport}
                        secrets={props.secrets}
                        scope={props.scope}
                        machines={props.machines}
                        onChange={(next) => props.onChangeBindings((current) => current.map((item) => (item.id === binding.id ? next : item)))}
                        onDelete={() => props.onChangeBindings((current) => current.filter((item) => item.id !== binding.id))}
                        onChangeConfigOverride={(fields) => onChangeServer((current) => {
                            if (binding.target.t === 'allMachines' || binding.target.t === 'project') {
                                return { ...applyMcpServerConfigOverrideV1(current, fields), updatedAt: Date.now() };
                            }
                            const configOverrides = (current.configOverrides ?? []).filter(override => reachPlaceKeyV1(override.target) !== reachPlaceKeyV1(binding.target));
                            if (fields) configOverrides.push({ ...fields, target: binding.target });
                            return { ...current, configOverrides, updatedAt: Date.now() };
                        })}
                    />
                ))}
                <McpServerBindingDraftExpander
                    serverId={props.draftServer.id}
                    machines={props.machines}
                    favoriteDirectories={favoriteDirectories}
                    onChangeFavoriteDirectories={setFavoriteDirectoriesRaw}
                    onAddBinding={(binding) => props.onChangeBindings((current) => [...current, binding])}
                />
            </ItemGroup>

            <McpServerTestPanel
                server={props.draftServer}
                bindings={props.draftBindings}
                machines={props.machines}
                targetSelection={props.targetSelection}
            />
        </>
    );
});

export type McpConfigurationSaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Everything the catalog entry holds about starting or reaching a server, edited in place (md C).
 * Local: command, arguments (one field each), working folder, environment. Remote: address, headers.
 * Each value commits when focus leaves it (`onCommit`); the server page saves there and says so in
 * the section's action. The new-server form (`mode="create"`) also chooses the transport.
 */
export const McpServerConfigurationSection = React.memo(function McpServerConfigurationSection(props: Readonly<{
    draftServer: McpServerCatalogEntryV1;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    /** `create` adds the transport choice; a saved server's transport is a fact of its header. */
    mode?: 'create' | 'edit';
    /** Section title and purpose (the server page names it Configuration). */
    title?: string;
    description?: string;
    /** A value was committed (field blur, a type or secret chosen, a row removed): save now. */
    onCommit?: () => void;
    saveState?: McpConfigurationSaveState;
    /** Names whose value is missing (the banner's "Add key" lands here). */
    attentionKeys?: ReadonlySet<string>;
    onChangeServer: (updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
}>) {
    const { theme } = useUnistyles();
    const { onChangeServer, onCommit } = props;
    const server = props.draftServer;
    const local = server.transport === 'stdio';
    const [folderMenuOpen, setFolderMenuOpen] = React.useState(false);
    const [folderChoice, setFolderChoice] = React.useState<'session' | 'path'>(server.stdio?.cwd?.t === 'path' ? 'path' : 'session');
    React.useEffect(() => { setFolderChoice(server.stdio?.cwd?.t === 'path' ? 'path' : 'session'); }, [server.stdio?.cwd?.t]);

    const transportOptions = React.useMemo(() => ([
        { id: 'stdio' as const, label: t('settings.mcpServersTransportLocalTitle'), description: t('settings.mcpServersTransportLocalSubtitle') },
        { id: 'http' as const, label: t('settings.mcpServersTransportHttpTitle'), description: t('settings.mcpServersTransportHttpSubtitle') },
        { id: 'sse' as const, label: t('settings.mcpServersTransportSseTitle'), description: t('settings.mcpServersTransportSseSubtitle') },
    ]), []);

    const setTransport = React.useCallback((transport: McpServerCatalogEntryTransportV1) => {
        onChangeServer((current) => (transport === 'stdio'
            ? { ...current, transport, stdio: current.stdio ?? { command: '', args: [] }, remote: undefined, updatedAt: Date.now() }
            : { ...current, transport, remote: current.remote ?? { url: '', headers: {} }, stdio: undefined, updatedAt: Date.now() }));
    }, [onChangeServer]);

    const setStdio = React.useCallback((patch: (stdio: NonNullable<McpServerCatalogEntryV1['stdio']>) => NonNullable<McpServerCatalogEntryV1['stdio']>) => {
        onChangeServer((current) => ({ ...current, stdio: patch(current.stdio ?? { command: '', args: [] }), updatedAt: Date.now() }));
    }, [onChangeServer]);

    const commitWith = React.useCallback((change: () => void) => {
        change();
        onCommit?.();
    }, [onCommit]);

    const folderItems = React.useMemo(() => [
        { id: 'session', title: t('capabilities.mcp.config.sessionFolder') },
        { id: 'path', title: t('capabilities.mcp.config.aFolder') },
    ], []);

    const savedLine = props.saveState === 'saved' || props.saveState === 'saving' || props.saveState === 'failed' ? (
        <View testID="mcp.server.config.saveState" style={styles.saved}>
            {props.saveState === 'saved' ? <Icon name="check" size={14} color={theme.colors.text.secondary} /> : null}
            <Text variant="meta" style={{ color: props.saveState === 'failed' ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
                {props.saveState === 'saved' ? t('capabilities.mcp.config.saved')
                    : props.saveState === 'saving' ? t('capabilities.mcp.config.saving')
                        : t('capabilities.mcp.config.saveFailed')}
            </Text>
        </View>
    ) : undefined;

    return (
        <ItemGroup
            testID="mcp.server.config"
            title={props.title ?? t('mcpSettings.connectionSection')}
            description={props.description ?? t('mcpSettings.connectionSectionDescription')}
            action={savedLine}
        >
            {props.mode === 'create' ? (
                <SegmentedChoiceItem<McpServerCatalogEntryTransportV1>
                    testID="mcp.server.transport"
                    testIDPrefix="mcp.server.transport"
                    title={t('settings.mcpServersFieldTransport')}
                    value={server.transport}
                    options={transportOptions}
                    onChange={setTransport}
                />
            ) : null}
            {local ? (
                <>
                    <FieldValueItem
                        testID="mcp.server.config.command"
                        fieldTestID="mcp.server.editor.command"
                        title={t('capabilities.mcp.config.command')}
                        subtitle={t('capabilities.mcp.config.commandDescription')}
                        value={server.stdio?.command ?? ''}
                        placeholder="npx"
                        monospace
                        onCommit={(draft) => {
                            const command = draft.trim();
                            commitWith(() => setStdio((stdio) => ({ ...stdio, command })));
                        }}
                    />
                    <Item
                        testID="mcp.server.config.arguments"
                        title={t('capabilities.mcp.config.arguments')}
                        // One field per argument, as wide as the values below it (Environment's rhythm).
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={(
                            <StringListField
                                testID="mcp.server.editor.args"
                                values={server.stdio?.args ?? []}
                                onChange={(args) => setStdio((stdio) => ({ ...stdio, args }))}
                                onCommit={onCommit}
                                itemLabel={(position) => t('capabilities.mcp.config.argument', { position })}
                                removeLabel={(position) => t('capabilities.mcp.config.removeArgument', { position })}
                                addLabel={t('capabilities.mcp.config.addArgument')}
                                monospace
                            />
                        )}
                    />
                    <DropdownMenu
                        testID="mcp.server.config.folder"
                        open={folderMenuOpen}
                        onOpenChange={setFolderMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={folderChoice}
                        showCategoryTitles={false}
                        matchTriggerWidth
                        connectToTrigger
                        rowKind="item"
                        itemTrigger={{ title: t('capabilities.mcp.config.workingFolder'), subtitle: t('capabilities.mcp.config.workingFolderDescription'), showSelectedSubtitle: false }}
                        items={folderItems}
                        onSelect={(id) => {
                            setFolderMenuOpen(false);
                            if (id === 'session') {
                                setFolderChoice('session');
                                commitWith(() => setStdio(({ cwd: _cwd, ...stdio }) => stdio));
                            } else {
                                setFolderChoice('path');
                            }
                        }}
                    />
                    {folderChoice === 'path' ? (
                        <FieldValueItem
                            testID="mcp.server.config.folderPath"
                            fieldTestID="mcp.server.editor.cwd"
                            title={t('capabilities.mcp.config.folderPath')}
                            value={server.stdio?.cwd?.t === 'path' ? server.stdio.cwd.path : ''}
                            placeholder="/srv/project"
                            monospace
                            autoFocus={server.stdio?.cwd?.t !== 'path'}
                            onCommit={(draft) => {
                                const path = draft.trim();
                                if (!path) return;
                                commitWith(() => setStdio((stdio) => ({ ...stdio, cwd: { t: 'path', path } })));
                            }}
                        />
                    ) : null}
                </>
            ) : (
                <FieldValueItem
                    testID="mcp.server.config.address"
                    fieldTestID="mcp.server.editor.url"
                    title={t('capabilities.mcp.config.address')}
                    subtitle={t('capabilities.mcp.config.addressDescription')}
                    // An address is long: it takes the row's width under its label.
                    accessoryLayout="stacked"
                    value={server.remote?.url ?? ''}
                    placeholder="https://example.com/mcp"
                    monospace
                    onCommit={(draft) => {
                        const url = draft.trim();
                        commitWith(() => onChangeServer((current) => ({ ...current, remote: { ...(current.remote ?? { headers: {} }), url }, updatedAt: Date.now() })));
                    }}
                />
            )}
            <Item
                testID={local ? 'mcp.server.config.env' : 'mcp.server.config.headers'}
                title={local ? t('capabilities.mcp.config.environment') : t('capabilities.mcp.config.headers')}
                subtitle={local ? t('capabilities.mcp.config.environmentDescription') : t('capabilities.mcp.config.headersDescription')}
                accessoryLayout="stacked"
                showChevron={false}
                rightElement={local ? (
                    <ValueRefRowsEditor
                        kind="env"
                        entries={server.env}
                        secrets={props.secrets}
                        scope={props.scope}
                        attentionKeys={props.attentionKeys}
                        addLabel={t('capabilities.mcp.config.addVariable')}
                        testIdPrefix="mcp.server.env"
                        onChangeEntries={(env) => commitWith(() => onChangeServer((current) => ({ ...current, env, updatedAt: Date.now() })))}
                    />
                ) : (
                    <ValueRefRowsEditor
                        kind="header"
                        entries={server.remote?.headers ?? {}}
                        secrets={props.secrets}
                        scope={props.scope}
                        attentionKeys={props.attentionKeys}
                        addLabel={t('capabilities.mcp.config.addHeader')}
                        testIdPrefix="mcp.server.headers"
                        onChangeEntries={(headers) => commitWith(() => onChangeServer((current) => ({ ...current, remote: { ...(current.remote ?? { url: '' }), headers }, updatedAt: Date.now() })))}
                    />
                )}
            />
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    saved: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
}));
