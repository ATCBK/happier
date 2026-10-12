import type { McpServerRuleV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { t } from '@/text';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { createHappierCollectionDraftTitleStore, createHappierCollectionVisitMemory, resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';

/** The collection's own route; its detail routes resolve beneath it. */
export const MCP_COLLECTION_ROUTE = SETTINGS_ROUTES.mcp;
export const MCP_NEW_SERVER_ROUTE = `${MCP_COLLECTION_ROUTE}/new`;
export const MCP_ON_MACHINE_ROUTE = SETTINGS_ROUTES.mcpOnMachine;
export const MCP_SESSION_PREVIEW_ROUTE = SETTINGS_ROUTES.mcpPreview;

export type McpAddMode = 'configure' | 'import-json' | 'quick-install';

export function mcpServerRoute(serverId: string): string {
    return `${MCP_COLLECTION_ROUTE}/${encodeURIComponent(serverId)}`;
}

export function newMcpServerRoute(mode: McpAddMode = 'configure', presetId?: string): string {
    if (mode === 'configure') return MCP_NEW_SERVER_ROUTE;
    const preset = presetId ? `&presetId=${encodeURIComponent(presetId)}` : '';
    return `${MCP_NEW_SERVER_ROUTE}?addMode=${mode}${preset}`;
}

export type McpServerCollectionRow = Readonly<{
    server: McpServerCatalogEntryV1;
    bindings: readonly McpServerRuleV1[];
    title: string;
    /** Applies nowhere: no enabled rule. Only this gets the rail's trouble dot. */
    unbound: boolean;
}>;

/** Servers by display name, each with the rules that apply it. */
export function buildMcpServerCollection(settings: McpServersSettingsV1, query: string): readonly McpServerCollectionRow[] {
    const bindingsByServerId = new Map<string, McpServerRuleV1[]>();
    for (const binding of settings.bindings) {
        const list = bindingsByServerId.get(binding.serverId);
        if (list) list.push(binding);
        else bindingsByServerId.set(binding.serverId, [binding]);
    }
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return settings.servers
        .map((server): McpServerCollectionRow => {
            const bindings = bindingsByServerId.get(server.id) ?? [];
            return {
                server,
                bindings,
                title: server.title || server.name || t('settings.mcpServersUnnamed'),
                unbound: !bindings.some((binding) => binding.enabled),
            };
        })
        .filter((row) => !normalizedQuery
            || row.title.toLocaleLowerCase().includes(normalizedQuery)
            || row.server.name.toLocaleLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.title.localeCompare(b.title));
}

/** Session memory of the server last opened, so returning to a wide collection lands on it. */
const mcpServerVisits = createHappierCollectionVisitMemory<string>();

export const recordMcpServerVisit = mcpServerVisits.record;

/** Beside the rail a server is always selected: the last one visited, else the first. */
export function resolveMcpServerLandingId(rows: readonly McpServerCollectionRow[]): string | null {
    return resolveHappierCollectionInitialKey({ keys: rows.map((row) => row.server.id), lastVisited: mcpServerVisits.read() });
}

/** The name typed into a new server's editor, shown on the collection's draft row. */
export const mcpServerDraftTitle = createHappierCollectionDraftTitleStore();
