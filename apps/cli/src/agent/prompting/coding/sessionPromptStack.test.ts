import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  commitActivePromptLibraryCatalog,
  getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareSessionPromptStackInputs } from './sessionPromptStack';

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
});

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
    accountContext: { scopeKey, lifetimeToken, settings: null },
    // A retained caller's former opt-in must no longer weaken Account admission.
    allowOptionalAccountLibrary: true,
  };
  await expect(prepareSessionPromptStackInputs(input)).rejects.toMatchObject({
    code: 'context_source_unavailable', status: 'preparation_pending', reason: 'unreachable',
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
