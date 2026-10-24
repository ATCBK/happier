import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  commitActivePromptLibraryCatalog,
  beginActivePromptLibraryCatalogRefresh,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareSessionPromptStackInputs } from './sessionPromptStack';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createDeferred } from '@/testkit/async/deferred';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveCliVoicePromptStackBlocks } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
});

it.each(['coding', 'voice'] as const)('%s awaits prompt inventory invalidated while the selected Profile is being prepared', async surface => runWithServerHttpBaseUrl('https://prompt-profile-race.test', async () => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'prompt-profile-race' })).toString('base64url')}.signature`, encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const catalog = { status: 'ready' as const, rows: [], tombstones: [{ key: surface, revision: 1 }], diagnostics: [] };
  setActiveAccountSettingsSnapshot({ scopeKey, source: 'cache', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog: catalog });
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Missing Account fixture');
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    readSourceSnapshot: getActiveAccountSettingsSnapshot, serverHttpBaseUrl: 'https://prompt-profile-race.test', isCurrent: async () => true });
  const profileIssued = createDeferred<void>();
  const profileRelease = createDeferred<void>();
  const promptRelease = createDeferred<void>();
  const profile = ProfileRecordV1Schema.parse({ v: 1, id: 'selected', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile: { v: 2, id: 'selected', name: 'Selected', createdAt: 1, updatedAt: 1 } } });
  // Replace only Home HTTP; Profile loading, captured Account refresh and prompt readiness stay real.
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/profiles') {
      profileIssued.resolve(); await profileRelease.promise;
      return { status: 200, data: { status: 'listed', rows: [{ id: profile.id, revision: 1, content: { t: 'plain', v: profile } }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
    }
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 1 } };
    if (path.endsWith('/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/entity-rows/prompt-library') {
      await promptRelease.promise;
      return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 2,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    throw new Error(`Unexpected preparation boundary: ${path}`);
  });
  let settled = false;
  const preparation = (surface === 'coding'
    ? prepareSessionPromptStackInputs({ credentials, metadata: { profileId: profile.id }, machineId: 'prompt-machine',
      accountContext: { scopeKey, lifetimeToken, settings: null }, operationContext })
    : resolveCliVoicePromptStackBlocks({ credentials, profileId: profile.id }))
    .finally(() => { settled = true; });
  // Observe rejection without letting the runner turn it into an unrelated unhandled failure.
  void preparation.catch(() => undefined);
  try {
    await profileIssued.promise;
    beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken });
    profileRelease.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (settled) await preparation;
    expect(settled).toBe(false);
    promptRelease.resolve();
    if (surface === 'coding') await expect(preparation).resolves.toMatchObject({ accountEntries: [], profileEntries: [] });
    else await expect(preparation).resolves.toEqual([]);
  } finally { profileRelease.resolve(); promptRelease.resolve(); await preparation.catch(() => undefined); }
}));

it('keeps unavailable Account inventory pending, then admits observed empty and current entries', async () => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'prompt-account' })).toString('base64url')}.signature`, encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    promptLibraryCatalog: { status: 'unavailable', reason: 'unreachable' },
  });
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  // HTTP is the boundary; catalog loading, Account lifetime and selection remain real.
  vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/encryption/currentness')
    ? { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
    : { status: 503, data: { error: 'unavailable' } });
  const input = { credentials, metadata: null, machineId: 'prompt-machine',
    // This Account-only preparation has no Session subject or Project context.
    projectEntries: [],
    accountContext: { scopeKey, lifetimeToken, settings: null },
    // A retained caller's former opt-in must no longer weaken Account admission.
    allowOptionalAccountLibrary: true,
  };
  await expect(prepareSessionPromptStackInputs(input)).rejects.toMatchObject({
    code: 'context_source_unavailable', status: 'preparation_pending', reason: 'unreachable',
    contextSource: 'account_prompt_inventory',
  });

  expect(commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: {
    status: 'ready', rows: [], tombstones: [{ key: 'coding', revision: 1 }], diagnostics: [],
  } })).toBe(true);
  expect((await prepareSessionPromptStackInputs(input)).accountEntries).toEqual([]);

  const entries = [{ id: 'current', ref: { kind: 'doc', artifactId: 'current-document' }, enabled: true,
    placement: 'system_append' }] satisfies PromptStackEntryV1[];
  const record = PromptLibraryRecordV1Schema.parse({ key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries } });
  expect(commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: {
    status: 'ready', rows: [{ record, revision: 2 }], tombstones: [], diagnostics: [],
  } })).toBe(true);
  expect((await prepareSessionPromptStackInputs(input)).accountEntries).toEqual(entries);
});
