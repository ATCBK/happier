import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import * as persistence from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { refreshActiveConnectedMetadataCatalog, refreshDemandedActiveConnectedMetadataCatalog } from './hydrateConnectedMetadataCatalog';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function publish(token: string) {
  const credentials = { token, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  return credentials;
}

it('retains confirmed database rollback through connected metadata hydration', async () => {
  const credentials = publish('metadata-rollback');
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
  });
  expect(await refreshActiveConnectedMetadataCatalog({ credentials })).toMatchObject({
    presentation: { status: 'unavailable', reason: 'database_transaction_conflict_exhausted' },
    acknowledgements: { status: 'unavailable', reason: 'database_transaction_conflict_exhausted' },
  });
});

it('publishes catalog-only changes without advancing Settings and reobserves an overtaking demanded wake', async () => {
  const credentials = publish('metadata-wake');
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'default' };
  let revision = 1;
  let firstReadStarted = false;
  let signalFirstRead!: () => void;
  const firstRead = new Promise<void>(resolve => { signalFirstRead = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/connected-metadata/presentation')) {
      const readRevision = revision;
      if (!firstReadStarted) { firstReadStarted = true; signalFirstRead(); await blocked; }
      return { status: 200, data: { status: 'present', revision: readRevision, content: { t: 'plain', v: { v: 1,
        entries: [{ v: 1, subject: { kind: 'account', account }, label: `Label ${readRevision}` }] } } } };
    }
    if (path.endsWith('/connected-metadata/acknowledgements')) return { status: 200, data: { status: 'present', revision,
      content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'warning', warningId: 'setup', scope: { kind: 'account' } }, acknowledged: false }] } } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
    return { status: 404, data: { error: 'unsupported' } };
  });
  await runWithServerHttpBaseUrl('https://metadata-wake.test', async () => {
    const pending = refreshActiveConnectedMetadataCatalog({ credentials });
    try {
      await Promise.race([firstRead, pending.then(result => {
        throw new Error(`Initial metadata demand settled before reaching the presentation HTTP boundary: ${JSON.stringify(result)}`);
      })]);
      revision = 2;
      const beforeWake = getActiveAccountSettingsSnapshot();
      const wake = refreshDemandedActiveConnectedMetadataCatalog({ token: credentials.token });
      // Let the stored-credential boundary admit the wake before the original response.
      await vi.waitFor(() => expect(getActiveAccountSettingsSnapshot()).not.toBe(beforeWake));
      release();
      await Promise.all([pending, wake]);
      expect(getActiveAccountSettingsSnapshot()?.connectedPresentationCatalog).toMatchObject({ status: 'ready', revision: 2,
        entries: [{ label: 'Label 2' }] });
      expect(getActiveAccountSettingsSnapshot()?.connectedAcknowledgementsCatalog).toMatchObject({ status: 'ready', revision: 2,
        entries: [{ acknowledged: false }] });
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    } finally { release(); await pending; }
  });
});

it('does not publish a late catalog into a replacement Account lifetime', async () => {
  const credentials = publish('metadata-original');
  let started = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/connected-metadata/presentation')) { started = true; await blocked; }
    return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } } };
  });
  const pending = runWithServerHttpBaseUrl('https://metadata-original.test', () => refreshActiveConnectedMetadataCatalog({ credentials }));
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    publish('metadata-replacement');
    const replacement = getActiveAccountSettingsSnapshot();
    release();
    expect(await pending).toMatchObject({ presentation: { status: 'unavailable', reason: 'scope-retired' } });
    expect(getActiveAccountSettingsSnapshot()).toBe(replacement);
    expect(getActiveAccountSettingsSnapshot()?.connectedPresentationCatalog).toBeUndefined();
  } finally { release(); await pending; }
});

it('does not demand metadata for an Account wake before any consumer requested it', async () => {
  const credentials = publish('metadata-not-demanded');
  const http = vi.spyOn(axios, 'get');
  await refreshDemandedActiveConnectedMetadataCatalog({ token: credentials.token });
  expect(http).not.toHaveBeenCalled();
});

it('reobserves demanded metadata rows without retained Settings or historical cleanup', async () => {
  const credentials = publish('metadata-current-demand');
  const reads: string[] = [];
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.startsWith('/v1/account/entity-rows/connected-metadata/')) return { status: 200, data: {
      status: 'deleted', revision: 2 } };
    return { status: 404, data: {} };
  });
  await refreshActiveConnectedMetadataCatalog({ credentials });
  reads.length = 0;
  await refreshDemandedActiveConnectedMetadataCatalog({ token: credentials.token });
  expect(getActiveAccountSettingsSnapshot()?.connectedPresentationCatalog).toMatchObject({ status: 'ready', revision: 2 });
  expect(getActiveAccountSettingsSnapshot()?.connectedAcknowledgementsCatalog).toMatchObject({ status: 'ready', revision: 2 });
  expect(reads.filter(path => !path.startsWith('/v1/account/entity-rows/connected-metadata/')
    && path !== '/v1/account/encryption/currentness')).toEqual([]);
});
