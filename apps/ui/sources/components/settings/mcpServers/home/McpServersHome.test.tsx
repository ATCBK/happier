import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import type { McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { buildMcpServerCollection } from '../collection/mcpServerCollectionModel';
import type { McpSignInView } from '../signIn/mcpSignInGrantView';
import { buildMcpHome } from './mcpHomeModel';
import { McpServersHomeView, type McpHomeData } from './McpServersHome';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }).module;
});

afterEach(() => standardCleanup());

type Kind = 'oauth' | 'key' | 'local' | 'remote';

function entry(
  id: string,
  kind: Kind,
  tools?: number,
): McpServerCatalogEntryV1 {
  const base = {
    id,
    name: id,
    title: id[0]!.toUpperCase() + id.slice(1),
    env: {},
  };
  const snapshot =
    tools === undefined
      ? {}
      : {
          toolsSnapshot: {
            checkedAt: 1,
            machineId: 'm1',
            tools: Array.from({ length: tools }, (_, i) => ({
              name: `t${i}`,
              tokens: 100,
            })),
          },
        };
  if (kind === 'local')
    return {
      ...base,
      transport: 'stdio',
      stdio: { command: 'npx', args: [] },
      ...snapshot,
    } as unknown as McpServerCatalogEntryV1;
  return {
    ...base,
    transport: 'http',
    remote: {
      url: `https://${id}.example/mcp`,
      headers:
        kind === 'key'
          ? { Authorization: { t: 'savedSecret', secretId: `secret-${id}` } }
          : {},
      ...(kind === 'oauth' ? { auth: { kind: 'oauth' } } : {}),
    },
    ...snapshot,
  } as unknown as McpServerCatalogEntryV1;
}

function settings(
  servers: readonly McpServerCatalogEntryV1[],
  off: readonly string[] = [],
): McpServersSettingsV1 {
  return {
    v: 1,
    servers: [...servers],
    bindings: servers
      .filter((server) => !off.includes(server.id))
      .map((server) => ({
        id: `rule-${server.id}`,
        serverId: server.id,
        enabled: true,
        target: { t: 'allMachines' },
      })),
  } as unknown as McpServersSettingsV1;
}

function home(
  input: Readonly<{
    servers: readonly McpServerCatalogEntryV1[];
    off?: readonly string[];
    secrets?: readonly string[];
    dismissed?: boolean;
    suggestions?: readonly string[];
  }>,
) {
  return buildMcpHome({
    rows: buildMcpServerCollection(settings(input.servers, input.off), ''),
    signInOf: () => null,
    savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null,
      (input.secrets ?? []).map(id => SavedSecretSchema.parse({ id, name: id, kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 })), ref) },
    firstVisitDismissed: input.dismissed ?? false,
    suggestions: (input.suggestions ?? []).map((key) => ({
      key,
      iconUrl: null,
      title: key,
    })),
  });
}


function homeData(servers: readonly McpServerCatalogEntryV1[], identity: string | null): McpHomeData {
  const model = buildMcpHome({
    rows: buildMcpServerCollection(settings(servers), ''),
    signInOf: () => ({ state: 'connected', identity, scopes: [], lastUsedAt: null }) as McpSignInView,
    savedSecretCatalog: { resolveReference: (ref) => resolveSavedSecretReference(null,
      ['secret-brave'].map((id) => SavedSecretSchema.parse({ id, name: id, kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 })), ref) },
    firstVisitDismissed: true,
  });
  return {
    model,
    suggestions: [],
    shelf: { items: [], loading: false, sourceId: null },
    loading: false,
    unavailable: false,
    reload: async () => undefined,
    dismissFirstVisit: () => undefined,
  } as unknown as McpHomeData;
}

describe('MCP homepage legend (lab hm-A2)', () => {
  it('says how each server reaches you right after its name, with no bare "Remote"', async () => {
    const screen = await renderScreen(
      <McpServersHomeView home={homeData([entry('fetch', 'local', 1), entry('github', 'oauth', 41), entry('brave', 'key'), entry('plain', 'remote')], 'leeroy-brun')} />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('npx · Everywhere');
    expect(text).toContain('as leeroy-brun');
    expect(text).toContain('API key · saved secret');
    expect(text).toContain('1 tool');
    expect(text).not.toMatch(/\b1 tools/);
    expect(text).not.toContain('Remote');
  });
});
