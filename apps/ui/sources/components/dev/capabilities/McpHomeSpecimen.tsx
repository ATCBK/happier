import * as React from 'react';
import type { McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import { buildMcpServerCollection } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { McpServersHomeView, type McpHomeData } from '@/components/settings/mcpServers/home/McpServersHome';
import { buildMcpHome, type McpHomeGrant } from '@/components/settings/mcpServers/home/mcpHomeModel';

type Cast = Readonly<{ id: string; title: string; kind: 'oauth' | 'key' | 'local'; tools: number; tokensPerTool: number; command?: string }>;

// The lab's cast (screens-home.js SV): what each server is, how it reaches, its tools.
const CAST: readonly Cast[] = [
    { id: 'context7', title: 'Context7', kind: 'key', tools: 2, tokensPerTool: 200 },
    { id: 'fetch', title: 'Fetch', kind: 'local', tools: 1, tokensPerTool: 300, command: 'uvx' },
    { id: 'github', title: 'GitHub', kind: 'oauth', tools: 41, tokensPerTool: 190 },
    { id: 'linear', title: 'Linear', kind: 'oauth', tools: 23, tokensPerTool: 178 },
    { id: 'playwright', title: 'Playwright', kind: 'local', tools: 21, tokensPerTool: 248, command: 'npx' },
    { id: 'postgres', title: 'Postgres', kind: 'local', tools: 6, tokensPerTool: 150, command: 'npx' },
    { id: 'sentry', title: 'Sentry', kind: 'oauth', tools: 14, tokensPerTool: 214 },
    { id: 'figma', title: 'Figma', kind: 'oauth', tools: 7, tokensPerTool: 300 },
];
const EXTRA = ['Notion', 'Supabase', 'Brave Search', 'Stripe', 'Vercel'];

function entry(cast: Cast, keyed: boolean): McpServerCatalogEntryV1 {
    const toolsSnapshot = { checkedAt: Date.now(), machineId: 'mbp', tools: Array.from({ length: cast.tools }, (_, index) => ({ name: `tool_${index}`, tokens: cast.tokensPerTool })) };
    if (cast.kind === 'local') {
        return { id: cast.id, name: cast.id, title: cast.title, transport: 'stdio', stdio: { command: cast.command ?? 'npx', args: [] },
            env: cast.id === 'postgres' && !keyed ? { DATABASE_URL: { t: 'savedSecret', secretId: 'missing' } } : {}, toolsSnapshot } as unknown as McpServerCatalogEntryV1;
    }
    return { id: cast.id, name: cast.id, title: cast.title, transport: 'http', env: {}, toolsSnapshot,
        remote: { url: `https://mcp.${cast.id}.example/mcp`, headers: cast.kind === 'key' ? { Authorization: { t: 'savedSecret', secretId: 'context7-key' } } : {},
            ...(cast.kind === 'oauth' ? { auth: { kind: 'oauth' } } : {}) } } as unknown as McpServerCatalogEntryV1;
}

function settingsFor(servers: readonly McpServerCatalogEntryV1[], off: readonly string[]): McpServersSettingsV1 {
    return { v: 1, servers: [...servers], bindings: servers.filter((server) => !off.includes(server.id))
        .map((server) => ({ id: `rule-${server.id}`, serverId: server.id, enabled: true, target: { t: 'everywhere' } })) } as unknown as McpServersSettingsV1;
}

const SHELF = [
    { sourceId: 'builtin:mcp-registry', kind: 'mcpServer' as const, itemId: 'com.notion/mcp', title: 'Notion', description: 'Search, read and update pages and databases.', publisher: { name: 'Notion' } },
    { sourceId: 'builtin:mcp-registry', kind: 'mcpServer' as const, itemId: 'com.supabase/mcp', title: 'Supabase', description: 'Tables, SQL and logs of your Supabase projects.', publisher: { name: 'Supabase' } },
    { sourceId: 'builtin:mcp-registry', kind: 'mcpServer' as const, itemId: 'io.github.brave/brave-search-mcp-server', title: 'Brave Search', description: 'Search the web and news with the Brave index.', publisher: { name: 'Brave' } },
];

/**
 * Dev-only (P7 U7.11): the homepage's moments with the lab cast, through the real view. Real data covers
 * the returning page on the QA Account; the first visit (no sign-in server yet), brand new, all ready and a
 * 13-server ring are judged here.
 */
export function McpHomeSpecimen(props: Readonly<{ moment: string }>) {
    const home = React.useMemo((): McpHomeData => {
        const moment = props.moment;
        const cast = moment === 'first' ? CAST.filter((item) => item.kind !== 'oauth') .concat(CAST.filter((item) => item.id === 'github').map((item) => ({ ...item, kind: 'key' as const })))
            : moment === 'new' ? []
                : moment === 'many' ? [...CAST, ...EXTRA.map((title, index) => ({ id: title.toLowerCase().replace(/ /g, '-'), title, kind: index % 2 ? 'local' as const : 'oauth' as const, tools: 4 + index, tokensPerTool: 120, command: 'npx' }))]
                    : CAST;
        const attention = moment === 'att' || moment === 'many';
        const servers = cast.map((item) => entry(item, !attention));
        const grants: Record<string, McpHomeGrant> = {
            github: { connected: true, identity: 'leeroy-brun' },
            linear: { connected: true, identity: 'leeroy@acme.dev' },
            sentry: attention ? { connected: false, identity: null } : { connected: true, identity: 'leeroy@acme.dev' },
            figma: { connected: true, identity: 'leeroy@acme.dev' },
            notion: null, supabase: { connected: true, identity: 'leeroy' }, stripe: { connected: true, identity: 'acme' },
        };
        const suggestions = ['linear', 'github', 'notion', 'playwright', 'sentry'].map((key) => ({ key: `suggestion:${key}`, iconUrl: null, title: key }));
        const model = buildMcpHome({
            rows: buildMcpServerCollection(settingsFor(servers, ['figma']), ''),
            grantOf: (serverId) => grants[serverId] ?? null,
            savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null, [SavedSecretSchema.parse({
                id: 'context7-key', name: 'Context7', kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'specimen-value' }, createdAt: 1, updatedAt: 1,
            })], ref) },
            firstVisitDismissed: false,
            suggestions,
        });
        return {
            model,
            suggestions,
            shelf: { items: SHELF, loading: false, sourceId: null, refresh: async () => undefined },
            loading: false,
            unavailable: false,
            reload: async () => undefined,
            dismissFirstVisit: () => undefined,
        } as unknown as McpHomeData;
    }, [props.moment]);
    return <McpServersHomeView home={home} />;
}
