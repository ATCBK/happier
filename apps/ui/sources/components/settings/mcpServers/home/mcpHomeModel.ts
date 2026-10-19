import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import type {
  HomeOrbitRingMark,
  HomeOrbitTether,
} from '@/components/atmosphere/orbit/homeOrbitScene';

import type { McpServerCollectionRow } from '../collection/mcpServerCollectionModel';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';

import { mcpServerAttentionStatus, type McpSavedSecretAvailability } from '../status/mcpServerStatus';
import { mcpSignInFact, type McpSignInView } from '../signIn/mcpSignInGrantView';

export type McpHomeServer = Readonly<{
  id: string;
  title: string;
  server: McpServerCatalogEntryV1;
  /** The reach rules that put it on machines: the legend says where a local server runs from them. */
  bindings: McpServerCollectionRow['bindings'];
  /** Legend group: held by the Account (remote, signed in or keyed once) or run on the machines (stdio). */
  group: 'account' | 'machine';
  tether: HomeOrbitTether;
  /** What the server needs from the person before it reaches anyone (the status vocabulary every list shares). */
  status: CapabilityStatus | null;
  /** OAuth identity the Account signed in as ("leeroy@acme.dev"). */
  identity: string | null;
  /** Tools and their per-turn tokens from the last Test; null until a machine has answered. */
  toolCount: number | null;
  tokens: number | null;
  off: boolean;
}>;

/** A ghost on a brand-new homepage's ring: a suggestion that is not added yet (faded, no tether). */
export type McpHomeSuggestionMark = Readonly<{
  key: string;
  iconUrl: string | null;
  title: string;
}>;

export type McpHome = Readonly<{
  servers: readonly McpHomeServer[];
  legend: Readonly<{
    account: readonly McpHomeServer[];
    machine: readonly McpHomeServer[];
  }>;
  ring: Readonly<{ marks: readonly HomeOrbitRingMark[]; more: number }>;
  present: Readonly<{
    servers: number;
    tools: number;
    tokens: number;
    toolsKnown: boolean;
  }>;
  needsYou: number;
  /** "Sign in once and they work on every machine": until dismissed or the first sign-in server exists. */
  firstVisitLine: boolean;
}>;

/** The ring holds this many marks; past it, the first `RING_ROOM - 1` and a "+N" mark (lab hm-A spec). */
export const MCP_RING_ROOM = 12;
export const MCP_RING_MORE_KEY = 'more';
const SUGGESTION_MARKS = 5;

export function mcpServerSignsIn(server: McpServerCatalogEntryV1): boolean {
  return server.transport !== 'stdio' && server.remote?.auth?.kind === 'oauth';
}

export function buildMcpHome(
  input: Readonly<{
    rows: readonly McpServerCollectionRow[];
    signInOf: (serverId: string) => McpSignInView | null;
    savedSecretCatalog: McpSavedSecretAvailability;
    firstVisitDismissed: boolean;
    suggestions?: readonly McpHomeSuggestionMark[];
  }>,
): McpHome {
  const servers = input.rows.map((row): McpHomeServer => {
    const { server } = row;
    const signIn = mcpServerSignsIn(server) ? input.signInOf(server.id) : null;
    const off = row.unbound;
    const status = off
      ? null
      : mcpServerAttentionStatus({
          entry: server,
          signIn: mcpSignInFact(signIn),
          savedSecretCatalog: input.savedSecretCatalog,
        });
    const group = server.transport === 'stdio' ? 'machine' : 'account';
    const tools = server.toolsSnapshot?.tools;
    return {
      id: server.id,
      title: row.title,
      server,
      bindings: row.bindings,
      group,
      tether: off ? 'none' : status ? 'attention' : group,
      status,
      identity: signIn?.state === 'connected' ? signIn.identity : null,
      toolCount: tools ? tools.length : null,
      tokens: tools ? tools.reduce((sum, tool) => sum + tool.tokens, 0) : null,
      off,
    };
  });
  const byName = (a: McpHomeServer, b: McpHomeServer) =>
    a.title.localeCompare(b.title);
  const inUse = servers.filter((server) => !server.off);
  // No usage producer exists for MCP servers: the ring leads with what needs the person, then what is in use.
  const ordered = [
    ...inUse.filter((server) => server.status).sort(byName),
    ...inUse.filter((server) => !server.status).sort(byName),
    ...servers.filter((server) => server.off).sort(byName),
  ];
  const ringMarks: HomeOrbitRingMark[] =
    servers.length === 0
      ? (input.suggestions ?? [])
          .slice(0, SUGGESTION_MARKS)
          .map((mark) => ({ key: mark.key, tether: 'none' }))
      : ordered.length <= MCP_RING_ROOM
        ? ordered.map((server) => ({ key: server.id, tether: server.tether }))
        : [
            ...ordered
              .slice(0, MCP_RING_ROOM - 1)
              .map((server) => ({ key: server.id, tether: server.tether })),
            { key: MCP_RING_MORE_KEY, tether: 'none', faded: false },
          ];
  const more =
    ordered.length > MCP_RING_ROOM ? ordered.length - (MCP_RING_ROOM - 1) : 0;
  const legendOrder = [...inUse].sort(byName);
  return {
    servers,
    legend: {
      account: legendOrder.filter((server) => server.group === 'account'),
      machine: legendOrder.filter((server) => server.group === 'machine'),
    },
    ring: { marks: ringMarks, more },
    present: {
      servers: inUse.length,
      tools: inUse.reduce((sum, server) => sum + (server.toolCount ?? 0), 0),
      tokens: inUse.reduce((sum, server) => sum + (server.tokens ?? 0), 0),
      toolsKnown: inUse.some((server) => server.toolCount !== null),
    },
    needsYou: inUse.filter((server) => server.status).length,
    firstVisitLine:
      !input.firstVisitDismissed &&
      servers.length > 0 &&
      !servers.some((server) => mcpServerSignsIn(server.server)),
  };
}
