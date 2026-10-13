import * as React from 'react';
import { View } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useMcpServersSettings } from '../useMcpServersSettings';
import { McpServerMark } from '../identity/McpServerMark';
import { mcpServerNeedsKey } from '../status/mcpServerStatus';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { shortWhereItsOn } from '@/components/capabilities/where/whereItsOnPresentation';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { AddMcpServerMenu } from './AddMcpServerMenu';
import { usePluginMcpServerItems } from './usePluginMcpServerItems';
import type { McpPluginItemMetadataV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import {
    buildMcpServerCollection,
    MCP_NEW_SERVER_ROUTE,
    MCP_ON_MACHINE_ROUTE,
    MCP_SESSION_PREVIEW_ROUTE,
    mcpServerDraftTitle,
    mcpServerRoute,
    type McpServerCollectionRow,
} from './mcpServerCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { AskHappierMark } from '@/components/sessions/bots/AskHappierOfferCard';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
const NO_PROJECTS: readonly Readonly<{ projectKey: string; name: string }>[] = [];

/**
 * The MCP servers collection: what other agents run on your machines (Found) first, the Account's
 * servers In use and Off, then Happier's own built-in server, which Settings → Actions governs. `rail` is the list beside the
 * selected detail; `page` is the same list as page sections where no rail shows (phones).
 * Selection comes from the route.
 */
export const McpServerCollection = React.memo(function McpServerCollection(props: Readonly<{
    variant: 'rail' | 'page';
    selectedServerId?: string | null;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const { settings, scope } = useMcpServersSettings();
    const [query, setQuery] = React.useState('');
    const rows = React.useMemo(() => buildMcpServerCollection(settings, query), [query, settings]);
    const inUse = React.useMemo(() => rows.filter((row) => !row.unbound), [rows]);
    const off = React.useMemo(() => rows.filter((row) => row.unbound), [rows]);
    const { machines: reachMachines } = useReachMachines();
    const placeMachines = React.useMemo(() => reachMachines.map((machine) => ({ machineId: machine.machineId, name: machine.name ?? machine.machineId })), [reachMachines]);
    const agentIds = React.useMemo(() => [...new Set(reachMachines.flatMap((machine) => machine.agentIds))], [reachMachines]);
    const { names } = useWhereItsOnNames({ agentIds, machines: placeMachines, projects: NO_PROJECTS });
    const savedSecretCatalog = useSavedSecretCatalog({ scope });
    const savedSecretIds = React.useMemo(() => new Set(savedSecretCatalog.materializedSecrets.map((secret) => secret.id)), [savedSecretCatalog.materializedSecrets]);
    const pluginItems = usePluginMcpServerItems();
    const plugins = React.useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        return pluginItems
            .filter((item) => !normalizedQuery || (item.title ?? item.name).toLocaleLowerCase().includes(normalizedQuery))
            .slice()
            .sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }, [pluginItems, query]);
    const total = settings.servers.length;
    const rail = props.variant === 'rail';

    const navigate = React.useCallback((href: string) => {
        // Beside a detail, choosing another item replaces the shown detail instead of stacking history.
        const result = runGuardedNavigation(() => (rail ? router.replace(href as never) : router.push(href as never)));
        if (result !== true) fireAndForget(result, { tag: 'McpServerCollection.navigate' });
    }, [rail, router]);

    const renderServerRow = (row: McpServerCollectionRow) => {
        const selected = rail && row.server.id === props.selectedServerId;
        const toolCount = row.server.toolsSnapshot?.tools.length;
        const tokens = row.server.toolsSnapshot?.tools.reduce((sum, tool) => sum + tool.tokens, 0);
        return (
            <CapabilityRow
                key={row.server.id}
                testID={`mcp.server.card.${row.server.id}`}
                title={row.title}
                description={row.server.description ?? null}
                whereSummary={shortWhereItsOn(row.bindings, names)}
                mark={<McpServerMark transport={row.server.transport} />}
                facts={{
                    presentation: 'row',
                    ...(toolCount !== undefined ? { cost: { toolCount, ...(tokens ? { tokensPerTurn: tokens } : {}) } } : {}),
                    extra: [row.server.transport === 'stdio' ? t('capabilities.mcp.local') : t('capabilities.mcp.remote')],
                }}
                status={mcpServerNeedsKey(row.server, savedSecretIds) ? { kind: 'key' } : null}
                density={rail ? 'rail' : 'page'}
                selected={rail ? selected : undefined}
                onPress={() => navigate(mcpServerRoute(row.server.id))}
            />
        );
    };

    // A plugin's server: read-only here (no Configuration, no Remove); Where and Tools still apply.
    const renderPluginRow = (item: McpPluginItemMetadataV1) => (
        <CapabilityRow
            key={item.id}
            testID={`mcp.server.plugin.${item.id}`}
            title={item.title ?? item.name}
            description={item.description ?? null}
            whereSummary={shortWhereItsOn(settings.bindings.filter((binding) => binding.serverId === item.id), names)}
            mark={<McpServerMark transport={item.transport} />}
            facts={{
                presentation: 'row',
                source: { kind: 'plugin', pluginName: item.source.pluginName },
                extra: [item.transport === 'stdio' ? t('capabilities.mcp.local') : t('capabilities.mcp.remote')],
            }}
            status={null}
            density={rail ? 'rail' : 'page'}
            selected={rail ? item.id === props.selectedServerId : undefined}
            onPress={() => navigate(mcpServerRoute(item.id))}
        />
    );

    // Pinned destinations: what other agents already run on your machines (Found), and, until the
    // session sheet (P8) replaces it, what a session gets.
    const renderToolRow = (id: 'onMachine' | 'preview') => {
        const href = id === 'onMachine' ? MCP_ON_MACHINE_ROUTE : MCP_SESSION_PREVIEW_ROUTE;
        const selected = rail && pathname === href;
        return (
            <Item
                key={id}
                testID={`settings.mcpServers.tool.${id}`}
                title={id === 'onMachine' ? t('capabilities.mcp.foundOnMachines') : t('mcpSettings.previewTitle')}
                icon={(
                    <HappierCollectionListMark>
                        <Icon name={id === 'onMachine' ? 'desktop' : 'eye'} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                selected={rail ? selected : undefined}
                accessibilityCurrent={selected ? 'page' : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => navigate(href)}
            />
        );
    };

    // Built in: Happier's own server is governed by Settings → Actions (T4), never by this page.
    const builtInRow = (
        <Item
            key="happier"
            testID="settings.mcpServers.builtIn.happier"
            title={t('capabilities.mcp.builtInHappier')}
            subtitle={t('capabilities.mcp.builtInHappierDescription')}
            icon={<HappierCollectionListMark><AskHappierMark size={20} /></HappierCollectionListMark>}
            detail={t('capabilities.mcp.builtInActions')}
            density={rail ? 'compact' : undefined}
            showChevron
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={() => {
                const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.actions as never));
                if (result !== true) fireAndForget(result, { tag: 'McpServerCollection.builtIn' });
            }}
        />
    );

    const addMenu = <AddMcpServerMenu onAdd={navigate} />;
    const searchable = total > SEARCH_THRESHOLD;
    const search = {
        testID: 'settings.mcpServers.search',
        value: query,
        onChangeText: setQuery,
        placeholder: t('mcpSettings.searchPlaceholder'),
    };
    const draftOpen = pathname === MCP_NEW_SERVER_ROUTE;

    if (rail) {
        return (
            <CollectionList
                testID="settings.mcpServers.rail"
                title={t('settings.mcpServers')}
                count={total}
                headerAction={addMenu}
                search={searchable ? search : null}
            >
                {renderToolRow('onMachine')}
                {renderToolRow('preview')}
                {draftOpen ? <McpServerDraftRow /> : null}
                {total === 0 && !draftOpen ? (
                    <EmptyState
                        testID="settings.mcpServers.empty"
                        layout="line"
                        title={t('settings.mcpServersEmptyTitle')}
                        lineDensity="compact"
                        lineRowStyle={collectionListStyles.row}
                    />
                ) : null}
                {inUse.length > 0 ? <CollectionListGroupLabel title={t('capabilities.mcp.inUse')} count={inUse.length} /> : null}
                {inUse.map(renderServerRow)}
                {off.length > 0 ? <CollectionListGroupLabel title={t('capabilities.mcp.off')} count={off.length} /> : null}
                {off.map(renderServerRow)}
                {plugins.length > 0 ? <CollectionListGroupLabel title={t('capabilities.mcp.fromPlugins')} count={plugins.length} /> : null}
                {plugins.map(renderPluginRow)}
                <CollectionListGroupLabel title={t('capabilities.mcp.builtIn')} />
                {builtInRow}
            </CollectionList>
        );
    }

    return (
        <ItemList testID="settings.mcpServers.page">
            <SettingsPageHeader description={t('mcpSettings.purpose')} actions={total > 0 ? addMenu : undefined} />
            {searchable ? (
                <CompactSearchField
                    testID={search.testID}
                    value={search.value}
                    onChangeText={search.onChangeText}
                    placeholder={search.placeholder}
                    placement="page"
                />
            ) : null}
            {total === 0 ? <EmptyState
                testID="settings.mcpServers.invitation"
                layout="page"
                variant="add"
                iconName="plug"
                title={t('mcpSettings.landingTitle')}
                subtitle={t('mcpSettings.landingDescription')}
                action={<AddMcpServerMenu onAdd={navigate} renderTrigger={(toggle) => <RoundButton
                    testID="settings.mcpServers.invitation.add" size="normal" title={t('mcpSettings.add')} onPress={toggle} />} />}
            /> : <ItemGroup title={t('settings.mcpServers')}>
                {rows.map(renderServerRow)}
            </ItemGroup>}
            <ItemGroup>
                {renderToolRow('onMachine')}
                {renderToolRow('preview')}
            </ItemGroup>
            {plugins.length > 0 ? (
                <ItemGroup title={t('capabilities.mcp.fromPlugins')}>
                    {plugins.map(renderPluginRow)}
                </ItemGroup>
            ) : null}
            <ItemGroup title={t('capabilities.mcp.builtIn')}>
                {builtInRow}
            </ItemGroup>
        </ItemList>
    );
});

/** The server being added in the detail pane, at the top of the rail, titled as it is typed. */
const McpServerDraftRow = React.memo(function McpServerDraftRow() {
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings.mcpServers.draft"
            titles={mcpServerDraftTitle}
            placeholder={t('mcpSettings.newServer')}
            mark={<HappierCollectionListMark><Icon name="terminal" size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
        />
    );
});
