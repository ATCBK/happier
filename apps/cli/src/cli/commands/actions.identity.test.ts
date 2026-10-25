import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import { handleActionsCommand } from './actions';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
  process.exitCode = undefined;
});

it('admits the same qualified widget Home through ambient and explicit generic Action invocation', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  // Credentials, saved profiles and HTTP are the external boundaries. The
  // generic command, credential target, executor and widget admission stay real.
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', session: 'fixture-terminal-enrollment' })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  // The saved Home is persisted at the settings boundary: Action target resolution
  // reads the exact Home identity back from it rather than from the injected profile read.
  const profile = await seedTestServerProfile({ id: 'profile-a', homeId: 'srv_home_a', serverUrl: 'https://home-a.example.test' });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 0 } };
    return { status: 404 };
  });
  const deps = {
    readCredentialsFn: async () => credentials,
    readCredentialsForServerIdFn: async () => credentials,
    getServerProfileFn: async () => profile,
  };
  const invoke = async (serverId: string, selector: readonly string[]) => {
    output = '';
    await handleActionsCommand(['invoke', 'widgets.item.list', '--input-json', JSON.stringify({
      surface: { serverId, accountId: 'owner', owner: { kind: 'home' } },
    }), ...selector, '--json'], deps);
    return JSON.parse(output) as unknown;
  };
  const explicit = await invoke('srv_home_a', ['--server-id', profile.id]);
  expect(explicit).toMatchObject({ ok: true, data: { instances: expect.any(Array) } });
  const ambient = await invoke('srv_home_a', []);
  expect(ambient, JSON.stringify(ambient))
    .toEqual(explicit);
  expect(await invoke('srv_other_home', []))
    .toMatchObject({ ok: false, error: { code: 'server_target_mismatch' } });
});
