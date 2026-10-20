import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as activeAccountSettingsSnapshot from './activeAccountSettingsSnapshot';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { LaunchProfileArtifactV1Schema, buildLaunchProfileArtifactHeaderV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { sameProviderConnectionsCatalogAuthority } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';

import {
    clearActiveAccountSettingsSnapshot,
    commitActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
    resolveActiveAccountSettingsSnapshotRevision,
    resolveActiveSavedSecretCatalogCollisionState,
  resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';

function snapshot(params: Readonly<{
  scopeKey: string;
  version: number;
  timing: 'after_foreground_ready' | 'after_runtime_idle';
}>) {
  return {
    source: 'network' as const,
    settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: params.timing }),
    settingsVersion: params.version,
    loadedAtMs: params.version,
    settingsSecretsReadKeys: [],
    scopeKey: params.scopeKey,
  };
}

const configuredExternalSessionSourceRevisions = activeAccountSettingsSnapshot as typeof activeAccountSettingsSnapshot & Readonly<{
  notifyActiveAccountConnectedServicesProjection(scopeKey: string): void;
  resolveActiveAccountConfiguredExternalSessionSourceRevision(
    snapshot: activeAccountSettingsSnapshot.ActiveAccountSettingsSnapshot | null,
  ): string;
}>;

describe('active account settings snapshot publication', () => {
  it.each([undefined, { status: 'loading' as const }])('retains privately prepared catalogs across an unchanged source observation (%j)', promptLibraryCatalog => {
    const source = { ...snapshot({ scopeKey: 'session-source', version: 1, timing: 'after_runtime_idle' }), promptLibraryCatalog };
    const admitted: PromptLibraryCatalogSnapshotV1 = { status: 'ready', rows: [], tombstones: [], diagnostics: [] };
    const operation = { ...source, promptLibraryCatalog: admitted };
    const next = { ...source, loadedAtMs: 2 };
    expect(activeAccountSettingsSnapshot.preserveAccountCatalogsInSnapshot(operation, next, source).promptLibraryCatalog).toBe(admitted);
    const withdrawn = { status: 'unavailable' as const, reason: 'forbidden' as const };
    expect(activeAccountSettingsSnapshot.preserveAccountCatalogsInSnapshot(operation,
      { ...next, promptLibraryCatalog: withdrawn }, source).promptLibraryCatalog).toBe(withdrawn);
    expect(activeAccountSettingsSnapshot.preserveAccountCatalogsInSnapshot(operation,
      { ...next, scopeKey: 'other-account' }, source).promptLibraryCatalog).toBe(promptLibraryCatalog);
  });
    it('withdraws cached Provider authority before disclosure when Account decryption material is retired', () => {
        const base = snapshot({ scopeKey: 'scope-provider-keys', version: 4, timing: 'after_runtime_idle' });
        const providerConnectionsCatalog = { status: 'ready' as const, revision: 7, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        setActiveAccountSettingsSnapshot({ ...base, settingsSecretsReadKeys: [new Uint8Array([1])], providerConnectionsCatalog });
        expect(readProviderSettingsForCli(getActiveAccountSettingsSnapshot()!).settings).toMatchObject({ connections: [] });
        setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 5, settingsSecretsReadKeys: [] });
        expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toEqual({ status: 'loading' });
        expect(() => readProviderSettingsForCli(getActiveAccountSettingsSnapshot()!)).toThrow();
    });
    it('retains admitted MCP authority with Provider neighbors across preferences but retires both on Account replacement', () => {
        const mcpServerCatalog = { status: 'ready' as const, revision: 7, authority: 'active' as const,
            catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }), diagnostics: [] };
        const providerConnectionsCatalog = { status: 'ready' as const, revision: 4, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' }),
            mcpServerCatalog, providerConnectionsCatalog });
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-a', version: 5, timing: 'after_foreground_ready' }));
        expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toBe(mcpServerCatalog);
        expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBe(providerConnectionsCatalog);
        expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetime);
        setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-b', version: 1, timing: 'after_runtime_idle' }));
        expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toBeUndefined();
        expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBeUndefined();
        expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBeGreaterThan(lifetime);
    });
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('retains equal preference and key material identities across a newer observed revision', () => {
    const first = { ...snapshot({ scopeKey: 'scope-refresh', version: 1, timing: 'after_runtime_idle' }),
      rawSettings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }, settingsSecretsReadKeys: [new Uint8Array([1, 2])] };
    setActiveAccountSettingsSnapshot(first);
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const next = { ...snapshot({ scopeKey: 'scope-refresh', version: 2, timing: 'after_runtime_idle' }),
      rawSettings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }, settingsSecretsReadKeys: [new Uint8Array([1, 2])] };
    const result = commitActiveAccountSettingsSnapshot(next);
    expect(result.didCommit).toBe(true);
    expect(result.snapshot.settingsVersion).toBe(2);
    expect(result.snapshot.settings).toBe(first.settings);
    expect(result.snapshot.rawSettings).toBe(first.rawSettings);
    expect(result.snapshot.settingsSecretsReadKeys).toBe(first.settingsSecretsReadKeys);
    expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetime);
    const changed = commitActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-refresh', version: 3, timing: 'after_foreground_ready' }));
    expect(changed.snapshot.settings).not.toBe(first.settings);
    expect(changed.snapshot.settings.sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
  });

  it('retains Provider admission when a newer preference publication reobserves the same row', () => {
    const base = snapshot({ scopeKey: 'scope-provider-refresh', version: 1, timing: 'after_runtime_idle' });
    const admitted = { status: 'ready' as const, revision: 4, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
    setActiveAccountSettingsSnapshot({ ...base, providerConnectionsCatalog: admitted });
    const reobserved = { ...admitted, catalog: ProviderConnectionsCatalogV1Schema.parse(admitted.catalog) };
    const result = commitActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2, providerConnectionsCatalog: reobserved });
    expect(result.didCommit).toBe(true);
    expect(sameProviderConnectionsCatalogAuthority(admitted, result.snapshot.providerConnectionsCatalog)).toBe(true);
    const changed = { ...reobserved, revision: 5 };
    const newer = commitActiveAccountSettingsSnapshot({ ...base, settingsVersion: 3, providerConnectionsCatalog: changed });
    expect(sameProviderConnectionsCatalogAuthority(admitted, newer.snapshot.providerConnectionsCatalog)).toBe(false);
  });

  it('publishes ACP row-only revisions and rejects a retired lifetime without rewriting preferences', () => {
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-acp', version: 7, timing: 'after_runtime_idle' }));
    const bound = { scopeKey: 'scope-acp', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const preferences = getActiveAccountSettingsSnapshot()!.settings;
    const observed: unknown[] = [];
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => observed.push(next?.acpCatalog));
    const first = { status: 'ready' as const, record: { v: 1 as const, definitions: [] }, revision: 1 };
    try {
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound, catalog: first })).toBe(true);
      const ready = getActiveAccountSettingsSnapshot();
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound, catalog: { ...first } })).toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toBe(ready);
      expect(observed).toHaveLength(1);
      expect(getActiveAccountSettingsSnapshot()?.settings).toBe(preferences);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
      activeAccountSettingsSnapshot.beginActiveAcpCatalogRefresh(bound);
      const loading = getActiveAccountSettingsSnapshot();
      expect(loading).not.toBe(ready);
      expect(activeAccountSettingsSnapshot.readActiveAcpCatalog()).toEqual({ status: 'loading' });
      const newer = { ...first, revision: 2 };
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound, catalog: newer })).toBe(true);
      const current = getActiveAccountSettingsSnapshot();
      expect(current).not.toBe(loading);
      expect(current?.acpCatalog).toBe(newer);
      expect(observed).toHaveLength(2);
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound, catalog: { ...newer } })).toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toBe(current);
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound, catalog: first })).toBe(false);
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound,
        catalog: { ...first, revision: 'absent', source: 'fresh', sourceSettingsVersion: 8 } })).toBe(false);
      expect(getActiveAccountSettingsSnapshot()).toBe(current);
      clearActiveAccountSettingsSnapshot();
      setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-acp', version: 7, timing: 'after_runtime_idle' }));
      expect(activeAccountSettingsSnapshot.commitActiveAcpCatalog({ ...bound, catalog: first })).toBe(false);
      expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toBeUndefined();
    } finally { unsubscribe(); }
  });

  it('keeps destination ACP authority across preferences but withdraws source projections and changed key material', () => {
    const base = snapshot({ scopeKey: 'scope-acp', version: 1, timing: 'after_runtime_idle' });
    const destination = { status: 'ready' as const, record: { v: 1 as const, definitions: [] }, revision: 4 };
    setActiveAccountSettingsSnapshot({ ...base, acpCatalog: destination });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2 });
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toBe(destination);
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 3, settingsSecretsReadKeys: [new Uint8Array([1])] });
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toEqual({ status: 'loading' });
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ ...base, acpCatalog: { ...destination, revision: 'absent', source: 'fresh', sourceSettingsVersion: 1 } });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2 });
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toEqual({ status: 'loading' });
  });

  it('retains opened host, channel and connected catalogs across same-Account preference changes and retires them on Account replacement', () => {
    const catalogs = {
      remoteHostCatalog: { status: 'ready' as const, hosts: [], revision: 3, diagnostics: [] },
      notificationChannelCatalog: { status: 'ready' as const, channels: [], revision: 4, diagnostics: [] },
      connectedPresentationCatalog: { status: 'ready' as const, entries: [], revision: 5, diagnostics: [] as const },
      connectedAcknowledgementsCatalog: { status: 'ready' as const, entries: [], revision: 6, diagnostics: [] as const },
    };
    setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }), ...catalogs });
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-a', version: 2, timing: 'after_foreground_ready' }));
    expect(getActiveAccountSettingsSnapshot()).toMatchObject(catalogs);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(2);
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-b', version: 1, timing: 'after_runtime_idle' }));
    for (const key of Object.keys(catalogs)) {
      expect(getActiveAccountSettingsSnapshot()).not.toHaveProperty(key);
    }
  });

  it('withdraws opened host, notification and connected catalogs when Account decryption material changes', () => {
    const base = snapshot({ scopeKey: 'scope-d10-key-retirement', version: 1, timing: 'after_runtime_idle' });
    const catalogs = {
      remoteHostCatalog: { status: 'ready' as const, hosts: [], revision: 3, diagnostics: [] },
      notificationChannelCatalog: { status: 'ready' as const, channels: [], revision: 4, diagnostics: [] },
      connectedPresentationCatalog: { status: 'ready' as const, entries: [], revision: 5, diagnostics: [] as const },
      connectedAcknowledgementsCatalog: { status: 'ready' as const, entries: [], revision: 6, diagnostics: [] as const },
    };
    setActiveAccountSettingsSnapshot({ ...base, ...catalogs, settingsSecretsReadKeys: [new Uint8Array([1])] });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2, settingsSecretsReadKeys: [new Uint8Array([1])] });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject(catalogs);
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 3, settingsSecretsReadKeys: [] });
    expect(activeAccountSettingsSnapshot.readActiveRemoteHostCatalog()).toEqual({ status: 'loading' });
    expect(activeAccountSettingsSnapshot.readActiveNotificationChannelCatalog()).toEqual({ status: 'loading' });
    expect(activeAccountSettingsSnapshot.readActiveConnectedPresentationCatalog()).toEqual({ status: 'loading' });
    expect(activeAccountSettingsSnapshot.readActiveConnectedAcknowledgementsCatalog()).toEqual({ status: 'loading' });
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(3);
  });

  it.each([
    {
      name: 'Remote hosts',
      read: () => activeAccountSettingsSnapshot.readActiveRemoteHostCatalog(),
      begin: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.beginActiveRemoteHostCatalogRefresh(bound),
      commit: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.commitActiveRemoteHostCatalog({ ...bound,
        catalog: { status: 'ready', hosts: [], revision: 3, diagnostics: [] } }),
    },
    {
      name: 'Notification channels',
      read: () => activeAccountSettingsSnapshot.readActiveNotificationChannelCatalog(),
      begin: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.beginActiveNotificationChannelCatalogRefresh(bound),
      commit: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.commitActiveNotificationChannelCatalog({ ...bound,
        catalog: { status: 'ready', channels: [], revision: 4, diagnostics: [] } }),
    },
    {
      name: 'Connected presentation',
      read: () => activeAccountSettingsSnapshot.readActiveConnectedPresentationCatalog(),
      begin: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.beginActiveConnectedPresentationCatalogRefresh(bound),
      commit: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.commitActiveConnectedPresentationCatalog({ ...bound,
        catalog: { status: 'ready', entries: [], revision: 5, diagnostics: [] } }),
    },
    {
      name: 'Connected acknowledgements',
      read: () => activeAccountSettingsSnapshot.readActiveConnectedAcknowledgementsCatalog(),
      begin: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.beginActiveConnectedAcknowledgementsCatalogRefresh(bound),
      commit: (bound: { scopeKey: string; lifetimeToken: number }) => activeAccountSettingsSnapshot.commitActiveConnectedAcknowledgementsCatalog({ ...bound,
        catalog: { status: 'ready', entries: [], revision: 6, diagnostics: [] } }),
    },
  ])('publishes $name readiness in its Account lifetime without rewriting preferences', ({ read, begin, commit }) => {
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-a', version: 7, timing: 'after_runtime_idle' }));
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const preferences = getActiveAccountSettingsSnapshot()!.settings;
    const publications: unknown[] = [];
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => publications.push(next));
    try {
      expect(commit(bound)).toBe(true);
      const first = read();
      expect(first.status).toBe('ready');
      expect(commit(bound)).toBe(true);
      expect(read()).toBe(first);
      expect(publications).toHaveLength(1);
      expect(getActiveAccountSettingsSnapshot()?.settings).toBe(preferences);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
      expect(begin(bound)).toBe(true);
      expect(read()).toEqual({ status: 'loading' });
      expect(publications).toHaveLength(1);
      expect(commit(bound)).toBe(true);
      expect(read()).toBe(first);
      expect(publications).toHaveLength(1);
      clearActiveAccountSettingsSnapshot();
      setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-a', version: 7, timing: 'after_runtime_idle' }));
      expect(commit(bound)).toBe(false);
      expect(begin(bound)).toBe(false);
      expect(read()).toEqual({ status: 'loading' });
    } finally { unsubscribe(); }
  });

  it('retains admitted Provider authority across preferences but not across Account replacement', () => {
    const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
    const ready = { status: 'ready' as const, revision: 7, catalog };
    setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      providerConnectionsCatalog: ready });
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-a', version: 2, timing: 'after_runtime_idle' }));
    expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBe(ready);
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-b', version: 1, timing: 'after_runtime_idle' }));
    expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBeUndefined();
  });

  it('publishes Provider catalog changes without a preference revision and refuses retired Account responses', () => {
    const first = snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(first);
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);
    const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
    const ready = { status: 'ready' as const, revision: 7, catalog };
    expect(activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ scopeKey: 'scope-a', lifetimeToken, catalog: ready })).toBe(true);
    const current = getActiveAccountSettingsSnapshot()!;
    expect(current.settings).toBe(first.settings);
    expect(current.settingsVersion).toBe(4);
    expect(readProviderSettingsForCli(current).settings).toEqual(DEFAULT_PROVIDER_SETTINGS_V1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ scopeKey: 'scope-a', lifetimeToken,
      catalog: { ...ready } })).toBe(true);
    expect(getActiveAccountSettingsSnapshot()).toBe(current);
    expect(getActiveAccountSettingsSnapshot()!.providerConnectionsCatalog).toBe(ready);
    expect(listener).toHaveBeenCalledTimes(1);
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot(first);
    expect(activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ scopeKey: 'scope-a', lifetimeToken, catalog: ready })).toBe(false);
    expect(getActiveAccountSettingsSnapshot()!.providerConnectionsCatalog).toBeUndefined();
    unsubscribe();
  });

  it('preserves admitted Provider row authority while publishing cleanup outcomes', () => {
    const admitted = { status: 'ready' as const, revision: 7, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
    const first = { ...snapshot({ scopeKey: 'scope-provider-cleanup', version: 4, timing: 'after_runtime_idle' }),
      providerConnectionsCatalog: admitted };
    setActiveAccountSettingsSnapshot(first);
    const bound = { scopeKey: first.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const reobserved = { ...admitted, catalog: structuredClone(admitted.catalog) };

    activeAccountSettingsSnapshot.beginActiveProviderConnectionsCatalogRefresh(bound);
    activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ ...bound, catalog: reobserved });
    expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBe(admitted);

    activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ ...bound,
      catalog: { ...reobserved, cleanup: { status: 'complete' } } });
    const completed = getActiveAccountSettingsSnapshot()!;
    expect(completed.providerConnectionsCatalog).toMatchObject({ cleanup: { status: 'complete' } });
    expect(sameProviderConnectionsCatalogAuthority(admitted, completed.providerConnectionsCatalog)).toBe(true);
    expect(completed.settings).toBe(first.settings);
    expect(completed.settingsVersion).toBe(first.settingsVersion);
    expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(bound.lifetimeToken);

    const changedCatalog = ProviderConnectionsCatalogV1Schema.parse({ ...admitted.catalog,
      connectionTombstones: [{ v: 1, id: 'pc_retired', contributionKey: null, lastDisplayName: 'Removed', deletedAt: 1 }] });
    activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ ...bound,
      catalog: { ...reobserved, catalog: changedCatalog } });
    const changed = getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog;
    expect(changed).toMatchObject({ status: 'ready', catalog: changedCatalog });
    expect(sameProviderConnectionsCatalogAuthority(admitted, changed)).toBe(false);

    activeAccountSettingsSnapshot.commitActiveProviderConnectionsCatalog({ ...bound,
      catalog: { ...reobserved, revision: admitted.revision + 1 } });
    expect(sameProviderConnectionsCatalogAuthority(admitted,
      getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog)).toBe(false);
  });

  it('retains an unchanged ready prompt snapshot while publishing loading, changed catalog and Settings transitions', () => {
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-prompt', version: 1, timing: 'after_runtime_idle' }));
    const bound = { scopeKey: 'scope-prompt', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const catalog = { status: 'ready', rows: [], tombstones: [], diagnostics: [] } satisfies PromptLibraryCatalogSnapshotV1;
    activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound, catalog });
    const ready = getActiveAccountSettingsSnapshot();
    activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound, catalog: { ...catalog } });
    expect(getActiveAccountSettingsSnapshot()).toBe(ready);

    activeAccountSettingsSnapshot.beginActivePromptLibraryCatalogRefresh(bound);
    const loading = getActiveAccountSettingsSnapshot();
    expect(loading).not.toBe(ready);
    expect(loading?.promptLibraryCatalog).toEqual({ status: 'loading' });
    activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound, catalog: { ...catalog } });
    const readmitted = getActiveAccountSettingsSnapshot();
    expect(readmitted).not.toBe(loading);
    expect(readmitted?.promptLibraryCatalog).toBe(catalog);

    activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound,
      catalog: { ...catalog, tombstones: [{ key: 'coding', revision: 2 }] } });
    const changed = getActiveAccountSettingsSnapshot();
    expect(changed).not.toBe(readmitted);
    expect(changed?.promptLibraryCatalog).toMatchObject({ tombstones: [{ key: 'coding', revision: 2 }] });

    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-prompt', version: 2, timing: 'after_foreground_ready' }));
    const settingsChanged = getActiveAccountSettingsSnapshot();
    expect(settingsChanged).not.toBe(changed);
    const retained = settingsChanged?.promptLibraryCatalog;
    if (!retained) throw new Error('Prompt catalog was not retained');
    activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound, catalog: retained });
    expect(getActiveAccountSettingsSnapshot()).toBe(settingsChanged);
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-prompt', version: 2, timing: 'after_foreground_ready' }));
    const replacement = getActiveAccountSettingsSnapshot();
    expect(activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound, catalog })).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(replacement);
    expect(replacement?.promptLibraryCatalog).toBeUndefined();
  });

  it('does not grant synchronous Role authority before the destination row census', () => {
    const rawSettings = { rolesV1: { overrides: { builder: { roleId: 'builder', workspaceWrites: 'allow' } } } };
    setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      rawSettings, settings: accountSettingsParse(rawSettings) });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound))
      .toEqual({ status: 'unavailable', reason: 'catalog-unobserved' });
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources({ ...bound, surface: 'coding' }))
      .toEqual({ status: 'unavailable', reason: 'catalog-unobserved' });
    activeAccountSettingsSnapshot.commitActivePromptLibraryCatalog({ ...bound,
      catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound))
      .toEqual({ status: 'ready', overrides: { builder: { roleId: 'builder', workspaceWrites: 'allow' } } });
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources({ ...bound, surface: 'coding' }))
      .toEqual({ status: 'ready', accountEntries: [], profileEntries: [] });
  });

  it('admits only observed Role overrides in the bound Account lifetime, never parser fallbacks', () => {
    const base = { ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] } };
    setActiveAccountSettingsSnapshot({ ...base, rawSettings: { rolesV1: { overrides: {
      builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'CURRENT', futureField: true },
    }, futureField: true } } });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound)).toEqual({ status: 'ready', overrides: {
      builder: { roleId: 'builder', workspaceWrites: 'deny', instructionsOverride: 'CURRENT' },
    } });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2, rawSettings: { rolesV1: { overrides: { builder: { roleId: 'builder', workspaceWrites: 'unexpected' } } } } });
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound)).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 3, rawSettings: {} });
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound)).toEqual({ status: 'ready', overrides: {} });
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ ...base, rawSettings: {} });
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound)).toEqual({ status: 'unavailable', reason: 'scope-retired' });
  });

  it('serves admitted destination catalogs independently of unavailable Account Settings content', () => {
    const entry = { id: 'destination-prompt', ref: { kind: 'doc' as const, artifactId: 'destination-doc' },
      enabled: true, placement: 'system_append' as const };
    setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      source: 'none', promptLibraryCatalog: { status: 'ready', tombstones: [], diagnostics: [], rows: [
        { revision: 3, record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [entry] } } },
        { revision: 4, record: { key: 'role-overrides', value: { v: 1, overrides: {
          builder: { roleId: 'builder', instructionsOverride: 'DESTINATION', workspaceWrites: 'deny' },
        } } } },
      ] },
    });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    expect(activeAccountSettingsSnapshot.readActiveAccountRoleOverrides(bound))
      .toEqual({ status: 'ready', overrides: { builder: { roleId: 'builder', instructionsOverride: 'DESTINATION', workspaceWrites: 'deny' } } });
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources({ ...bound, surface: 'coding' }))
      .toEqual({ status: 'ready', accountEntries: [entry], profileEntries: [] });
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources({ ...bound, surface: 'voice' }).status).toBe('unavailable');
  });

  it('reads prompt layers from the current admitted Account, refusing malformed or retired sources', () => {
    const base = { ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] } };
    const entry = { id: 'prompt-a', ref: { kind: 'doc' as const, artifactId: 'doc-a' }, enabled: true, placement: 'system_append' as const };
    const rawSettings = { promptStacksV1: { v: 1, surfaces: { coding: [entry], profilesById: { profile: [entry] } } } };
    setActiveAccountSettingsSnapshot({ ...base, settings: accountSettingsParse(rawSettings), rawSettings });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), surface: 'coding' as const, profileId: 'profile' };
    const read = () => activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(bound);
    expect(read()).toEqual({ status: 'ready', accountEntries: [entry], profileEntries: [entry] });
    const profileEntry = { ...entry, id: 'profile-only' };
    const profileCatalog = { status: 'ready' as const, authority: 'active' as const, control: null,
      controlRevision: 'absent' as const, diagnostics: [], referenceGuardRevision: 'absent' as const,
      records: [{ revision: 0, record: { v: 1 as const, id: 'profile', enabled: true, skillSeeds: [], secretBindings: {},
        definition: { kind: 'artifact' as const, artifactId: 'profile-definition' }, promptStack: [profileEntry] } }],
    };
    expect(activeAccountSettingsSnapshot.commitActiveProfileCatalog({ ...bound, catalog: profileCatalog })).toBe(true);
    expect(read()).toEqual({ status: 'ready', accountEntries: [entry], profileEntries: [profileEntry] });
    activeAccountSettingsSnapshot.beginActiveProfileCatalogRefresh(bound);
    expect(read()).toEqual({ status: 'unavailable', reason: 'profile-catalog-incomplete' });
    activeAccountSettingsSnapshot.commitActiveProfileCatalog({ ...bound, catalog: { ...profileCatalog, records: [] } });
    expect(read()).toEqual({ status: 'unavailable', reason: 'profile-target-unavailable' });
    activeAccountSettingsSnapshot.commitActiveProfileCatalog({ ...bound, catalog: { ...profileCatalog, authority: 'inactive' } });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2, rawSettings: { promptStacksV1: { v: 99 } } });
    expect(read()).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 3, rawSettings: {} });
    expect(read()).toEqual({ status: 'ready', accountEntries: [], profileEntries: [] });
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ ...base, rawSettings: {} });
    expect(read()).toEqual({ status: 'unavailable', reason: 'scope-retired' });
  });

  it('retains the ready Profile catalog when only the same Account Settings revision advances', () => {
    const profileCatalog = {
      status: 'ready' as const,
      authority: 'active' as const,
      control: null,
      controlRevision: 'absent' as const,
      records: [],
      diagnostics: [],
      referenceGuardRevision: 'absent' as const,
    };
    setActiveAccountSettingsSnapshot({
      ...snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' }),
      profileCatalog,
    });

    const result = commitActiveAccountSettingsSnapshot(
      snapshot({ scopeKey: 'scope-a', version: 5, timing: 'after_runtime_idle' }),
    );

    expect(result.snapshot).toHaveProperty('profileCatalog', profileCatalog);
  });

  it('uses fresh native Profile rows selected by the canonical catalog without a transfer marker', () => {
    const profileEntry = { id: 'native-profile-prompt', ref: { kind: 'doc' as const, artifactId: 'native-doc' },
      enabled: true, placement: 'system_append' as const };
    setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
      rawSettings: {}, profileCatalog: { status: 'ready', authority: 'inactive', source: 'destination', control: null,
        controlRevision: 'absent', diagnostics: [], referenceGuardRevision: 0,
        records: [{ revision: 0, record: { v: 1, id: 'native', enabled: true, skillSeeds: [], secretBindings: {},
          definition: { kind: 'artifact', artifactId: 'native-definition' }, promptStack: [profileEntry] } }],
      },
    });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      surface: 'coding' as const, profileId: 'native' };
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(bound))
      .toEqual({ status: 'ready', accountEntries: [], profileEntries: [profileEntry] });
    activeAccountSettingsSnapshot.commitActiveProfileCatalog({ ...bound, catalog: { status: 'ready', authority: 'inactive',
      source: 'legacy', control: null, controlRevision: 'absent', diagnostics: [], referenceGuardRevision: 0, records: [],
    } });
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(bound))
      .toEqual({ status: 'ready', accountEntries: [], profileEntries: [] });
  });

  it.each(['enabled', 'remembered'] as const)('admits a visible builtin from captured %s selection without private membership or stale retained attachments', evidence => {
    const profileId = 'gemini-api-key';
    const staleEntry = { id: 'retained-builtin-prompt', ref: { kind: 'doc', artifactId: 'retained-doc' },
      enabled: true, placement: 'system_append' };
    const rawSettings = { profileEnabledById: evidence === 'enabled' ? { [profileId]: true } : {}, promptStacksV1: { v: 1,
      surfaces: { profilesById: { [profileId]: [staleEntry] } } } };
    const profileCatalog = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const,
      control: null, controlRevision: 'absent' as const, diagnostics: [], referenceGuardRevision: 'absent' as const, records: [] };
    const base = { ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      promptLibraryCatalog: { status: 'ready' as const, rows: [], tombstones: [], diagnostics: [] }, profileCatalog };
    setActiveAccountSettingsSnapshot({ ...base, rawSettings, settings: accountSettingsParse(rawSettings) });
    const memory = { lastUsedProfile: evidence === 'remembered' ? profileId : null };
    const profilesSnapshot = readProfilesFromAccountSettings(rawSettings, new Map(), memory, profileCatalog);
    expect(profilesSnapshot.visibleProfiles.find(profile => profile.id === profileId)).toBeDefined();
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), surface: 'voice' as const, profileId, profilesSnapshot };
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(bound))
      .toEqual({ status: 'ready', accountEntries: [], profileEntries: [] });
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources({ ...bound, profileId: 'unknown' }))
      .toEqual({ status: 'unavailable', reason: 'profile-target-unavailable' });
    const disabledRaw = { ...rawSettings, profileEnabledById: { [profileId]: false } };
    setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 2, rawSettings: disabledRaw, settings: accountSettingsParse(disabledRaw) });
    const disabledBound = { ...bound, profilesSnapshot: readProfilesFromAccountSettings(disabledRaw, new Map(), memory, profileCatalog) };
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(disabledBound))
      .toEqual({ status: 'unavailable', reason: 'profile-target-unavailable' });
  });

  it('admits an actually opened granted Profile without membership, but rejects absence without that selection evidence', () => {
    const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
      profile: { v: 2, id: 'grant-only', name: 'Granted', createdAt: 1, updatedAt: 1 }, secretBindings: {} });
    const resource = { artifactId: 'granted-definition', header: buildLaunchProfileArtifactHeaderV1(content),
      body: JSON.stringify(content), access: 'view', ownerAccountId: 'other-account',
      revision: { headerVersion: 2, bodyVersion: 3 } } satisfies ArtifactSharingResourceV1;
    const profileCatalog = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const,
      control: null, controlRevision: 'absent' as const, diagnostics: [], referenceGuardRevision: 'absent' as const, records: [] };
    setActiveAccountSettingsSnapshot({ ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      rawSettings: {}, promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] }, profileCatalog });
    const bound = { scopeKey: 'scope-a', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), surface: 'voice' as const, profileId: 'grant-only' };
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(bound))
      .toEqual({ status: 'unavailable', reason: 'profile-target-unavailable' });
    const admitted = { ...bound, profilesSnapshot: readProfilesFromAccountSettings({}, new Map([[resource.artifactId, resource]]),
      { lastUsedProfile: null }, profileCatalog) };
    expect(admitted.profilesSnapshot.visibleProfiles).toMatchObject([{ id: 'grant-only', artifactId: resource.artifactId }]);
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(admitted))
      .toEqual({ status: 'ready', accountEntries: [], profileEntries: [] });
    clearActiveAccountSettingsSnapshot();
    expect(activeAccountSettingsSnapshot.readActiveAccountPromptStackSources(admitted))
      .toEqual({ status: 'unavailable', reason: 'scope-retired' });
  });

  it('publishes a catalog-only change and rejects a retired Account lifetime without changing Settings', () => {
    const first = snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(first);
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);
    const catalog = { status: 'ready' as const, authority: 'inactive' as const, control: null,
      controlRevision: 'absent' as const, records: [], diagnostics: [], referenceGuardRevision: 7 };
    expect(activeAccountSettingsSnapshot.commitActiveProfileCatalog({ scopeKey: 'scope-a', lifetimeToken, catalog })).toBe(true);
    expect(getActiveAccountSettingsSnapshot()?.settings).toBe(first.settings);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(4);
    expect(listener).toHaveBeenCalledTimes(1);
    activeAccountSettingsSnapshot.beginActiveProfileCatalogRefresh({ scopeKey: 'scope-a', lifetimeToken });
    expect(activeAccountSettingsSnapshot.readActiveProfileCatalog().status).toBe('loading');
    expect(activeAccountSettingsSnapshot.commitActiveProfileCatalog({ scopeKey: 'scope-a', lifetimeToken, catalog })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot(first);
    expect(activeAccountSettingsSnapshot.commitActiveProfileCatalog({ scopeKey: 'scope-a', lifetimeToken, catalog })).toBe(false);
    unsubscribe();
  });

  it('invalidates a Profile runtime revision when only transfer authority changes', () => {
    const catalog = { status: 'ready' as const, authority: 'inactive' as const, control: null,
      controlRevision: 'absent' as const, records: [], diagnostics: [], referenceGuardRevision: 7 };
    const base = snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' });
    expect(resolveActiveAccountSettingsSnapshotRevision({ ...base, profileCatalog: catalog }))
      .not.toBe(resolveActiveAccountSettingsSnapshotRevision({ ...base, profileCatalog: { ...catalog, controlRevision: 2 } }));
    expect(resolveActiveAccountSettingsSnapshotRevision({ ...base, profileCatalog: catalog }))
      .not.toBe(resolveActiveAccountSettingsSnapshotRevision({ ...base, profileCatalog: { ...catalog, source: 'destination' } }));
  });

  it('projects collision state from the authoritative Account snapshot without mutating it', () => {
    const next = {
      ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
      settings: accountSettingsParse({
        secrets: [{
          id: 'happier:shared-secret:v1:legacy-personal',
          name: 'Legacy',
          kind: 'token',
          encryptedValue: { _isSecretValue: true, value: 'exact-value' },
          createdAt: 1,
          updatedAt: 7,
        }],
      }),
    };
    setActiveAccountSettingsSnapshot(next);

    const active = getActiveAccountSettingsSnapshot();
    if (!active) throw new Error('expected active snapshot');
    expect(active).toBe(next);
    expect(resolveActiveSavedSecretCatalogCollisionState(active)).toEqual({
      status: 'migration_required',
      collisions: [{
        ref: 'happier:shared-secret:v1:legacy-personal',
        expectedUpdatedAt: 7,
      }],
    });
  });

  it('keeps the same-scope accepted winner for equal and older commits without notifying', () => {
    const winner = snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(winner);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    const equal = commitActiveAccountSettingsSnapshot(
      snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_foreground_ready' }),
    );
    const older = commitActiveAccountSettingsSnapshot(
      snapshot({ scopeKey: 'scope-a', version: 3, timing: 'after_foreground_ready' }),
    );

    expect(equal).toEqual({ snapshot: winner, didCommit: false });
    expect(older).toEqual({ snapshot: winner, didCommit: false });
    expect(getActiveAccountSettingsSnapshot()).toBe(winner);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('allows a different credential scope to become the active winner', () => {
    const previous = snapshot({ scopeKey: 'scope-a', version: 9, timing: 'after_runtime_idle' });
    const next = snapshot({ scopeKey: 'scope-b', version: 1, timing: 'after_foreground_ready' });
    setActiveAccountSettingsSnapshot(previous);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    expect(commitActiveAccountSettingsSnapshot(next)).toEqual({ snapshot: next, didCommit: true });
    expect(getActiveAccountSettingsSnapshot()).toBe(next);
    expect(listener).toHaveBeenCalledWith(previous, next);
    unsubscribe();
  });

  it('preserves the independent Saved Secret catalog across a newer same-Account Settings publication', () => {
    const resourceDataKey = new Uint8Array(32).fill(23);
    const previous = {
      ...snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' }),
      savedSecretCatalogState: 'ready' as const,
      savedSecretResources: [{
        resourceId: 'resource-e2ee',
        ownerAccountId: 'owner-account',
        displayName: 'Shared API key',
        kind: 'apiKey' as const,
        encryptionMode: 'e2ee' as const,
        revision: 7,
        storedContent: { t: 'encrypted' as const, c: 'AA==' },
        materialStatus: 'ready' as const,
        resourceDataKey,
      }],
    };
    setActiveAccountSettingsSnapshot(previous);

    const committed = commitActiveAccountSettingsSnapshot(
      snapshot({ scopeKey: 'scope-a', version: 5, timing: 'after_foreground_ready' }),
    );

    expect(committed.snapshot.savedSecretCatalogState).toBe('ready');
    expect(committed.snapshot.savedSecretResources).toBe(previous.savedSecretResources);
    expect([...resourceDataKey]).toEqual(new Array(32).fill(23));
  });

  it('publishes the canonical accepted snapshot after sharing unchanged same-Account values', () => {
    setActiveAccountSettingsSnapshot(snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' }));
    const next = snapshot({ scopeKey: 'scope-a', version: 5, timing: 'after_foreground_ready' });
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);
    try {
      const committed = commitActiveAccountSettingsSnapshot(next);
      expect(committed.snapshot).toEqual(next);
      expect(committed.snapshot.settings).toBe(next.settings);
      expect(getActiveAccountSettingsSnapshot()).toBe(committed.snapshot);
      expect(listener.mock.calls[0]?.[1]).toBe(committed.snapshot);
    } finally { unsubscribe(); }
  });

    it('keeps a committed winner when a subscriber throws', () => {
        const next = snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' });
        const unsubscribe = subscribeActiveAccountSettingsSnapshot(() => {
      throw new Error('consumer wake failed');
    });

    expect(commitActiveAccountSettingsSnapshot(next)).toEqual({ snapshot: next, didCommit: true });
        expect(getActiveAccountSettingsSnapshot()).toBe(next);
        unsubscribe();
    });

    it('publishes the null transition when logout clears the active Account snapshot', () => {
        const previous = snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' });
        setActiveAccountSettingsSnapshot(previous);
        const listener = vi.fn();
        const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

        clearActiveAccountSettingsSnapshot();

        expect(getActiveAccountSettingsSnapshot()).toBeNull();
        expect(listener).toHaveBeenCalledWith(previous, null);
        unsubscribe();
    });

    it('zeroes opened Saved Secret resource DEKs when the Account lifetime is revoked', () => {
        const resourceDataKey = new Uint8Array(32).fill(23);
        setActiveAccountSettingsSnapshot({
            ...snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' }),
            savedSecretCatalogState: 'ready',
            savedSecretResources: [{
                resourceId: 'resource-e2ee',
                ownerAccountId: 'owner-account',
                displayName: 'Shared API key',
                kind: 'apiKey',
                encryptionMode: 'e2ee',
                revision: 1,
                storedContent: { t: 'encrypted', c: 'AA==' },
                materialStatus: 'ready',
                resourceDataKey,
            }],
        });

        clearActiveAccountSettingsSnapshot();

        expect([...resourceDataKey]).toEqual(new Array(32).fill(0));
    });

    it('advances the incumbent lifetime only when an Account enters, changes, or is revoked', () => {
        const before = getActiveAccountSettingsSnapshotLifetimeToken();

        setActiveAccountSettingsSnapshot(
            snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' }),
        );
        const accountA = getActiveAccountSettingsSnapshotLifetimeToken();

        setActiveAccountSettingsSnapshot(
            snapshot({ scopeKey: 'scope-a', version: 5, timing: 'after_foreground_ready' }),
        );
        const accountARevision = getActiveAccountSettingsSnapshotLifetimeToken();

        setActiveAccountSettingsSnapshot(
            snapshot({ scopeKey: 'scope-b', version: 1, timing: 'after_foreground_ready' }),
        );
        const accountB = getActiveAccountSettingsSnapshotLifetimeToken();

        setActiveAccountSettingsSnapshot(
            snapshot({ scopeKey: 'scope-a', version: 2, timing: 'after_runtime_idle' }),
        );
        const accountAAgain = getActiveAccountSettingsSnapshotLifetimeToken();

        clearActiveAccountSettingsSnapshot();
        const cleared = getActiveAccountSettingsSnapshotLifetimeToken();

        clearActiveAccountSettingsSnapshot();
        const clearedAgain = getActiveAccountSettingsSnapshotLifetimeToken();

        setActiveAccountSettingsSnapshot(
            snapshot({ scopeKey: 'scope-a', version: 6, timing: 'after_runtime_idle' }),
        );
        const accountAReentered = getActiveAccountSettingsSnapshotLifetimeToken();

        expect(accountA).toBeGreaterThan(before);
        expect(accountARevision).toBe(accountA);
        expect(accountB).toBeGreaterThan(accountA);
        expect(accountAAgain).toBeGreaterThan(accountB);
        expect(cleared).toBeGreaterThan(accountAAgain);
        expect(clearedAgain).toBe(cleared);
        expect(accountAReentered).toBeGreaterThan(cleared);
    });

  it('keeps configured transcript sources current across unrelated catalog and queue preference changes', () => {
    const cached = { ...snapshot({ scopeKey: 'source-account', version: 4, timing: 'after_runtime_idle' }), source: 'cache' as const };
    setActiveAccountSettingsSnapshot(cached);
    const sourceRevision = configuredExternalSessionSourceRevisions
      .resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot());
    expect(activeAccountSettingsSnapshot.commitActiveProfileCatalog({
      scopeKey: cached.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { status: 'ready', authority: 'inactive', control: null,
        controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 7 },
    })).toBe(true);
    expect(configuredExternalSessionSourceRevisions
      .resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot())).toBe(sourceRevision);

    const hydrated = getActiveAccountSettingsSnapshot()!;
    setActiveAccountSettingsSnapshot({ ...hydrated, settingsVersion: 5,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }) });
    expect(configuredExternalSessionSourceRevisions
      .resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot())).toBe(sourceRevision);
    clearActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot(hydrated);
    expect(configuredExternalSessionSourceRevisions
      .resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot())).not.toBe(sourceRevision);
  });

  it('invalidates configured sources when the initial version-zero settings read becomes available', () => {
    const unavailable = { ...snapshot({ scopeKey: 'source-account', version: 0, timing: 'after_runtime_idle' }), source: 'none' as const };
    setActiveAccountSettingsSnapshot(unavailable);
    const sourceRevision = configuredExternalSessionSourceRevisions
      .resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot());

    expect(commitActiveAccountSettingsSnapshot({ ...unavailable, source: 'network', rawSettings: {}, loadedAtMs: 1 }).didCommit).toBe(true);
    expect(configuredExternalSessionSourceRevisions
      .resolveActiveAccountConfiguredExternalSessionSourceRevision(getActiveAccountSettingsSnapshot())).not.toBe(sourceRevision);
  });

  it('retires configured sources on consumed source settings or Account key withdrawal', () => {
    const sources = [{ sourceKind: 'configuredHome', instances: [{ kind: 'agentSetting',
      settingId: 'piAgentDir', byServerIdSettingId: 'piAgentDirByServerId', field: 'homePath', normalization: 'configuredPath' }] }];
    const initial = { ...snapshot({ scopeKey: 'source-account', version: 1, timing: 'after_runtime_idle' }),
      settings: accountSettingsParse({ piAgentDir: '/native/fallback', piAgentDirByServerId: { home: '/native/first', other: '/other' } }),
      settingsSecretsReadKeys: [new Uint8Array(32).fill(1)] };
    setActiveAccountSettingsSnapshot(initial);
    const revision = () => activeAccountSettingsSnapshot.resolveActiveAccountConfiguredExternalSessionSourceRevision(
      getActiveAccountSettingsSnapshot(), sources, 'home');
    const first = revision();
    setActiveAccountSettingsSnapshot({ ...initial, settingsVersion: 2,
      settings: accountSettingsParse({ piAgentDir: '/changed/fallback', piAgentDirByServerId: { home: '/native/first', other: '/changed/other' },
        sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }) });
    expect(revision()).toBe(first);
    setActiveAccountSettingsSnapshot({ ...initial, settingsVersion: 3,
      settings: accountSettingsParse({ piAgentDir: '/native/fallback', piAgentDirByServerId: { home: '/native/second' } }) });
    expect(revision()).not.toBe(first);
    const changedSource = revision();
    setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, settingsVersion: 4,
      settingsSecretsReadKeys: [] });
    expect(revision()).not.toBe(changedSource);
  });

  it('publishes a Connected Services-only projection through the active source revision without changing Settings revision', () => {
    const active = snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(active);
    const sourceRevisionBefore =
      configuredExternalSessionSourceRevisions
        .resolveActiveAccountConfiguredExternalSessionSourceRevision(active);
    const settingsRevisionBefore = resolveActiveAccountSettingsSnapshotRevision(active);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    configuredExternalSessionSourceRevisions
      .notifyActiveAccountConnectedServicesProjection('scope-a');

    expect(getActiveAccountSettingsSnapshot()).toBe(active);
    expect(resolveActiveAccountSettingsSnapshotRevision(active)).toBe(settingsRevisionBefore);
    expect(
      configuredExternalSessionSourceRevisions
        .resolveActiveAccountConfiguredExternalSessionSourceRevision(active),
    ).not.toBe(sourceRevisionBefore);
    expect(listener).toHaveBeenCalledWith(active, active);

    configuredExternalSessionSourceRevisions
      .notifyActiveAccountConnectedServicesProjection('scope-b');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
