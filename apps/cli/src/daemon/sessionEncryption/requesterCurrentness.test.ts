import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { readRequesterHomeWithinActionLifetime, runWithRequesterSessionCurrentnessCheckpoint } from './requesterCurrentness';
import { prepareRequesterSessionBootstrap } from './requesterSessionCredentials';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { createAccountSettingsConnectedAccountSecrets } from '../connectedServices/qualifiedConnectedAccountDaemonPersistence';

it('preserves requester custody across unavailable observations and recovers safe reads inside the caller lifetime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-currentness-'));
  const channel = await createRequesterCurrentnessSocketHarness();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.fixture`;
  let current = true;
  let profileStatus = 200;
  let settingsUnavailable = false;
  let settingsVersion = 2;
  let profileReads = 0;
  let profileGate: (() => Promise<void>) | undefined;
  let releasePendingProfile: (() => void) | undefined;
  const purposes = emptyConnectedAccountCatalogRecordV1('purposes');
  const home = fastify();
  home.get('/*', async (request, reply) => {
    const path = request.url;
    if (path.endsWith('/profile')) {
      profileReads++;
      const status = profileStatus;
      profileStatus = 200;
      await profileGate?.();
      return reply.code(status).send(status === 200 ? { id: 'bob' } : { error: 'unavailable' });
    }
    if (path.endsWith('/currentness')) return { mode: 'plain', version: 1,
      updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
    if (path.endsWith('/account/encryption')) return { mode: 'plain', updatedAt: 1 };
    if (path.endsWith('/entity-rows/connected-accounts/purposes')) return {
      status: 'present', revision: 1, content: { t: 'plain', v: purposes },
    };
    if (path === '/v2/account/settings') {
      if (settingsUnavailable) return reply.code(503).send({ error: 'unavailable' });
      return { content: { t: 'plain', v: {} }, version: settingsVersion };
    }
    throw new Error(`Unexpected requester read ${path}`);
  });
  await home.ready();
  const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: 'https://requester-currentness.test' });
  const prepare = (signal?: AbortSignal) => prepareRequesterSessionBootstrap({ credentials: { token, encryption: null },
    attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
    boundary: { serverId: 'home', serverHttpBaseUrl: 'https://requester-currentness.test', happyHomeDir: directory },
    // Machine admission is the external authority boundary; Account reads,
    // socket observation, Settings publication and private custody remain real.
    verifyMachineAdmissionCurrent: async () => current, signal });
  let prepared: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> = null;
  try {
    prepared = await prepare();
    if (!prepared) throw new Error('Expected admitted requester');
    const bootstrap = prepared.admitted;
    const custody = bootstrap.savedSecretOperationContext;
    const snapshot = custody.readSnapshot();
    await channel.disconnect();
    await expect(custody.isCurrent()).rejects.toMatchObject({ retryable: true });
    expect(custody.readSnapshot()).toBe(snapshot);
    await channel.reconnect();
    expect(await custody.isCurrent()).toBe(true);

    settingsUnavailable = true;
    await channel.hintSettings(++settingsVersion);
    await expect(bootstrap.ensureAccountSettingsCurrent()).rejects.toMatchObject({ response: { status: 503 } });
    settingsUnavailable = false;
    expect(await bootstrap.ensureAccountSettingsCurrent()).toBe(true);

    const signal = new AbortController().signal;
    await runWithRequesterSessionCurrentnessCheckpoint(async () => {
      profileStatus = 503;
      await expect(custody.isCurrent()).rejects.toMatchObject({ response: { status: 503 } });
      expect(await custody.isCurrent()).toBe(true);
    });
    profileStatus = 503;
    expect(await readRequesterHomeWithinActionLifetime(() => custody.isCurrent(), signal)).toBe(true);
    expect(await custody.commitConnectedAccountCatalog({ key: 'purposes', catalog: { status: 'ready', record: purposes, revision: 1 } })).toBe(true);
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ operationContext: custody });
    profileStatus = 503;
    expect(await readRequesterHomeWithinActionLifetime(() => store.read(signal), signal)).toEqual(purposes.value);
    const secrets = createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: custody.readSnapshot()!.scopeKey, operationContext: custody });
    profileStatus = 503;
    expect(await readRequesterHomeWithinActionLifetime(() => secrets.readMaterial!('missing-secret', { signal }), signal)).toBeNull();
    let enteredProfile!: () => void;
    const entered = new Promise<void>(resolve => { enteredProfile = resolve; });
    const held = new Promise<void>(resolve => { releasePendingProfile = resolve; });
    profileGate = async () => { profileGate = undefined; enteredProfile(); await held; };
    const reader = new AbortController();
    const cancelledRead = expect(store.read(reader.signal)).rejects.toBeDefined();
    await entered;
    reader.abort();
    await cancelledRead;
    expect(custody.readSnapshot()).not.toBeNull();
    releasePendingProfile?.();
    expect(await custody.isCurrent()).toBe(true);
    profileStatus = 403;
    const beforeRefusal = profileReads;
    await expect(readRequesterHomeWithinActionLifetime(() => custody.isCurrent(), signal)).rejects.toMatchObject({ response: { status: 403 } });
    expect(profileReads - beforeRefusal).toBe(1);
    const cancelled = new AbortController();
    cancelled.abort();
    const beforeCancellation = profileReads;
    await expect(bootstrap.isCurrent(cancelled.signal)).rejects.toBeDefined();
    await expect(readRequesterHomeWithinActionLifetime(() => custody.isCurrent(), cancelled.signal)).rejects.toBeDefined();
    await expect(store.read(cancelled.signal)).rejects.toBeDefined();
    await expect(secrets.readMaterial?.('missing-secret', { signal: cancelled.signal })).rejects.toBeDefined();
    expect(profileReads).toBe(beforeCancellation);
    const beforeColdBackground = profileReads;
    let backgroundFailure: unknown;
    profileStatus = 503;
    try { await (await prepare(signal))?.cleanupOnFailure(); }
    catch (error) { backgroundFailure = error; }
    expect(backgroundFailure).toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
    expect(profileReads - beforeColdBackground).toBe(1);
    profileStatus = 503;
    const cold = await readRequesterHomeWithinActionLifetime(() => prepare(signal), signal);
    expect(cold).not.toBeNull();
    await cold?.cleanupOnFailure();
    current = false;
    expect(await custody.isCurrent()).toBe(false);
    expect(custody.readSnapshot()).toBeNull();
  } finally {
    releasePendingProfile?.();
    await prepared?.cleanupOnFailure();
    restoreHttp();
    await home.close();
    await channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});
