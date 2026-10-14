import { expect, it } from 'vitest';
import { ProfileRecordV1Schema, buildProfilePhysicalKey, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliProfileStore } from './profileStore';
import { createActionExecutor, getActionSpec } from '@happier-dev/protocol';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { createCliProfileActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliProfileActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

it('saves a retained 0.2-shaped Profile and deletes it through the real Action binding, HTTP catalog and SQLite tombstone', async () => {
  const database = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-actions-', initAuth: true, initEncrypt: true });
  const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
  try {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    // The unversioned definition is the predecessor AIBackendProfile writer's shape
    // (../0.2 packages/protocol/src/profiles/backendProfileSchema.ts); its row is current custody.
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'legacy-review', enabled: true, secretBindings: { MASKED: null },
      definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse({ id: 'legacy-review', name: 'Frontend review',
        environmentVariables: [], compatibility: { claude: true }, createdAt: 1, updatedAt: 1 }) }, skillSeeds: ['kept-seed'],
      promptStack: [
        { id: 'consumed', enabled: true, skillMigrationV1: true, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing-consumed' } },
        { id: 'disabled', enabled: false, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing-disabled' } },
      ] });
    const key = buildProfilePhysicalKey(record.id);
    await db.userKVStore.create({ data: { accountId: account.id, key, version: 1,
      value: new TextEncoder().encode(JSON.stringify(sealProfileRecordContentV1({ mode: 'plain', material: null, record }))) } });
    accountRoutes(server);
    artifactsRoutes(server);
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    await runWithServerHttpBaseUrl(origin, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        profileActionExecute: createCliProfileActionExecuteV1({ credentials, serverId: 'profile-home', serverHttpBaseUrl: origin,
          callMachineAction: async () => { throw new Error('Unexpected Machine boundary'); } }),
      });
      const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'profile-home' };
      const read = await executor.execute('launch_profiles.read', { id: record.id }, context);
      expect(read.ok, JSON.stringify(read)).toBe(true);
      const opened = getActionSpec('launch_profiles.read').outputSchema.parse(read.ok ? read.result : undefined);
      if (opened.status !== 'present' || !('revision' in opened)) throw new Error('Expected the captured legacy row');
      const saved = await executor.execute('launch_profiles.save', { id: record.id, expectedRevision: opened.revision,
        profile: { ...opened.profile, name: 'Frontend review saved', updatedAt: 2 } }, context);
      expect(saved).toMatchObject({ ok: true, result: { status: 'updated', id: record.id, revision: 2 } });
      expect(getActionSpec('launch_profiles.save').outputSchema.safeParse(saved.ok ? saved.result : undefined).success).toBe(true);
      const store = createCliProfileStore({ credentials });
      expect(await store.readProfileCatalog({ migrateSkills: true })).toMatchObject({ status: 'ready', records: [{ revision: 2,
        record: { skillSeeds: record.skillSeeds, promptStack: record.promptStack, secretBindings: record.secretBindings,
          definition: { kind: 'legacy', profile: { name: 'Frontend review saved' } } } }] });
      const removed = await executor.execute('launch_profiles.delete', { id: record.id, expectedRevision: 2 }, {
        ...context, presentUserConfirmation: { actionId: 'launch_profiles.delete' },
      });
      expect(removed).toMatchObject({ ok: true, result: { status: 'updated', id: record.id, revision: 3 } });
      expect(getActionSpec('launch_profiles.delete').outputSchema.safeParse(removed.ok ? removed.result : undefined).success).toBe(true);
      for (let pass = 0; pass < 2; pass++) expect(await store.readProfileCatalog({ migrateSkills: true })).toMatchObject({
        status: 'ready', records: [], tombstones: [{ id: record.id, revision: 3 }],
      });
      const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } });
      expect(row).toMatchObject({ version: 3, value: null });
      expect(await executor.execute('launch_profiles.save', { id: record.id, expectedRevision: 2,
        profile: opened.profile }, context)).toMatchObject({ ok: true, result: { status: 'conflict' } });
      expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value).toBeNull();
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    await server.close(); await database.close();
  }
}, 120_000);

it('loads disabled unavailable Profile custody through real authenticated HTTP and SQLite without a seed or write', async () => {
  const database = await createLightSqliteHarness({ tempDirPrefix: 'happier-b1fix-c-profile-', initAuth: true, initEncrypt: true });
  const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
  try {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'retained-profile', enabled: true, secretBindings: {},
      definition: { kind: 'inline', profile: { v: 2, id: 'retained-profile', name: 'Retained', createdAt: 1, updatedAt: 1 } },
      promptStack: [{ id: 'disabled', enabled: false, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing' } }] });
    const key = buildProfilePhysicalKey(record.id);
    const encode = (value: typeof record) => new TextEncoder().encode(JSON.stringify(sealProfileRecordContentV1({ mode: 'plain', material: null, record: value })));
    await db.userKVStore.create({ data: { accountId: account.id, key, version: 1, value: encode(record) } });
    let artifactReads = 0; let mutations = 0;
    server.addHook('onRequest', async request => {
      if (request.url.startsWith('/v1/artifacts/')) artifactReads++;
      if (request.method === 'POST' && request.url.startsWith('/v1/account/entity-rows/profiles')) mutations++;
    });
    accountRoutes(server);
    artifactsRoutes(server);
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    await runWithServerHttpBaseUrl(origin, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const store = createCliProfileStore({ credentials });
      expect(await store.readProfileCatalog({ migrateSkills: true })).toMatchObject({ status: 'ready',
        records: [{ revision: 1, record: { skillSeeds: [], promptStack: record.promptStack } }] });
      expect(artifactReads).toBe(0); expect(mutations).toBe(0);
      expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).version).toBe(1);
      // Retained data becomes decision-material only when the entry is enabled.
      const enabled = ProfileRecordV1Schema.parse({ ...record, promptStack: record.promptStack.map(entry => ({ ...entry, enabled: true })) });
      await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key } }, data: { value: encode(enabled), version: 2 } });
      expect(await store.readProfileCatalog({ migrateSkills: true })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
      expect(artifactReads).toBe(1); expect(mutations).toBe(0);
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    await server.close(); await database.close();
  }
}, 120_000);
