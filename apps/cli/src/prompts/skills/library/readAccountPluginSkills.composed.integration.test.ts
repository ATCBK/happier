import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { createLightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { registerPluginAvailabilityRoutes } from '../../../../../server/sources/app/plugins/availability/routes';
import { createPluginAvailabilityOperations } from '../../../../../server/sources/app/plugins/availability/operations';
import { getOrCreateServerIdentityId } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { eventRouter } from '../../../../../server/sources/app/events/connectionEventRouter';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import { projectPluginMachineMaterializationReportFactsV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { projectReleaseLessPluginDeclarations } from '@/plugins/availability/releaseLessDeclarations';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readPluginSkills } from './readPluginSkills';
import { seedPluginSkillDefaults } from './seedPluginSkillDefaults';
import { pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import type { RpcHandler } from '@/api/rpc/types';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

describe('installed external plugin skills through Account discovery', () => {
  let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-plugin-skill-availability-', initAuth: true, initEncrypt: true });
  }, 0);
  afterAll(async () => { if (sqlite) await sqlite.close(); });

  it('lists, reads, seeds reach and copies an installed external plugin skill through authenticated HTTP and SQLite', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_SERVER_UI_DIR', 'HAPPIER_SERVER_UI_REQUIRED']);
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../server/sources/app/api/types').Fastify;
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
      accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
      value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
    } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const pluginId = 'com.acme.library-skills';
    const skillId = pluginSkillIdV1({ pluginId, localId: 'check' });
    const author = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      skills: { check: { directory: './resources/check' } } });
    let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    let sourceSockets: Server | undefined;
    try {
      env.patch({ HAPPIER_SERVER_UI_DIR: undefined, HAPPIER_SERVER_UI_REQUIRED: '0' });
      enableOptionalStatics(app); accountRoutes(app); artifactsRoutes(app); machinesRoutes(app); registerPluginAvailabilityRoutes(app);
      sourceSockets = new Server(app.server, { path: '/v1/updates' });
      const url = await app.listen({ port: 0, host: '127.0.0.1' });
      env.patch({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/plugin-library-home`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
      reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
      runtime = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        plugins: [{ manifest: author.manifest, files: { 'daemon.mjs': 'export function activate() {}',
          'resources/check/SKILL.md': '---\nname: check\ndescription: Check a project\n---\nCheck instructions',
          'resources/check/reference.txt': 'Supporting content',
        } }] });
      const homeId = await getOrCreateServerIdentityId(), machineId = 'plugin-library-machine';
      await db.machine.create({ data: { id: machineId, accountId: account.id, installationId: 'plugin-library-installation',
        metadata: encodePlainMachineStoredContent({ host: 'Plugin source', platform: process.platform, homeDir: runtime.happyHomeDir }),
        dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), active: true, lastActiveAt: new Date() } });
      const materializationId = runtime.registry.contributes.materializationIdsByPluginId?.[pluginId];
      if (!materializationId) throw new Error('Installed source materialization is unavailable');
      // A UI-capable neighbour shares the daemon's complete census with the
      // installed external skill. Exercise the real release-slot producer:
      // leaking its graph into Machine facts hides every newly installed item.
      const uiManifest = PluginManifestV2Schema.parse({ ...author.manifest, id: 'com.acme.ui-source', contributes: {
        ui: { renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }] },
      } });
      const uiGraph = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
        artifactId: 'panel', tier: 'reactNative', entry: 'react-native/panel/entry.cjs.bundle',
        files: [{ relativePath: 'react-native/panel/entry.cjs.bundle', digest: `sha256:${'a'.repeat(64)}`, byteSize: 1 }],
        digest: `sha256:${'b'.repeat(64)}`, builtWith: { bundler: 'esbuild', version: '0.27.2' },
        executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
      }] });
      const neighbour = projectReleaseLessPluginDeclarations({
        activationTargets: [{ pluginId: uiManifest.id, manifest: uiManifest, generatedUiArtifactsManifest: uiGraph }],
        sourceCustodiesByPluginId: new Map([[uiManifest.id, { kind: 'bundled_first_party',
          packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture' } }]]),
        registryMaterializationIdsByPluginId: {}, observedAt: 1,
      }).get(uiManifest.id)?.runtimeMaterialization;
      if (!neighbour) throw new Error('Expected an admitted neighbour census');
      await createPluginAvailabilityOperations().reportMaterializations({ accountId: account.id, publisherMachineId: machineId,
        input: { expectedRevision: null, snapshot: { serverIdentityId: homeId, machineId, materializations: [{
          serverIdentityId: homeId, machineId, materializationId, pluginId, version: '1.0.0', sourceClass: 'localPath',
          portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: Date.now(),
        } as const, { ...neighbour, serverIdentityId: homeId, machineId }].map(projectPluginMachineMaterializationReportFactsV1) } } });
      const sourceHandlers = new Map<string, RpcHandler>();
      const currentRuntime = runtime;
      registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { sourceHandlers.set(method, handler); } }, {
        resolveRuntimeRegistry: async () => currentRuntime.registry,
        resolveGeneration: async () => currentRuntime.controller.getState().generation,
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: homeId, machineId }),
      });
      sourceSockets.use((socket, next) => {
        void auth.verifyTokenForRoute(String(socket.handshake.auth.token)).then(verified => {
          if (verified?.userId === account.id) next(); else next(new Error('Unauthorized'));
        }, next);
      });
      let sourceUnavailable = false;
      sourceSockets.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, async (raw: unknown, acknowledge: (value: unknown) => void) => {
        if (!raw || typeof raw !== 'object' || !('method' in raw) || !('params' in raw)
          || raw.method !== `${machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
          acknowledge({ ok: false, error: 'unsupported_method' }); return;
        }
        if (sourceUnavailable) {
          acknowledge({ ok: false, error: 'Source discovery unavailable', errorCode: 'RPC_TRANSPORT_UNAVAILABLE' }); return;
        }
        const result = await sourceHandlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!(raw.params);
        expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse(result).projection.familiesById.skills?.entriesById[`${pluginId}/check`])
          .toMatchObject({ pluginId, definition: { id: 'check' }, occurrenceId: runtime!.registry.contributes.occurrenceIdsByPluginId?.[pluginId] });
        acknowledge({ ok: true, result });
      }));
      eventRouter.setIo(sourceSockets);
      await runWithServerHttpBaseUrl(url, async () => {
        await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
        const accountStore = createCliApprovalsArtifactStore({ credentials });
        const port = accountStore.skillRules;
        const skills = await readPluginSkills(undefined, undefined, currentRuntime.registry.contributes);
        await seedPluginSkillDefaults({ skills, port });
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global', mode: 'plain', ctx: null });
        const execute = createActionExecutor(deps);
        const context = { surface: 'ui', authority: 'present_user' } as const;
        const listed = await execute.execute('skills.list', {}, context);
        expect(listed.ok).toBe(true);
        if (!listed.ok) throw new Error('Plugin skill list failed');
        const item = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.result).items.find(item => item.skillId === skillId);
        expect(item).toMatchObject({ name: 'check', provenance: { kind: 'plugin', pluginId }, rules: [expect.objectContaining({ enabled: true })] });
        const read = await execute.execute('skills.read', { skillId, file: 'reference.txt' }, context);
        expect(read.ok).toBe(true);
        if (!read.ok) throw new Error('Plugin skill read failed');
        expect(SkillReadResultV1Schema.parse(read.result)).toMatchObject({ skillId, file: { path: 'reference.txt' } });
        const copied = await execute.execute('skills.duplicate', { skillId }, context);
        expect(copied.ok, copied.ok ? undefined : copied.errorCode).toBe(true);
        if (!copied.ok) throw new Error('Plugin skill copy failed');
        const copy = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(copied.result);
        const storedCopy = await accountStore.promptLibraryStore.read(copy.skillId);
        expect(storedCopy).toMatchObject({ header: { skillLock: { provenance: { kind: 'written' } } } });
        const edited = await execute.execute('skills.update', { skillId: copy.skillId, expectedRevision: copy.revision,
          description: 'My editable copy' }, context);
        expect(edited).toMatchObject({ ok: true });
        expect(await execute.execute('skills.update', { skillId, expectedRevision: item!.revision, description: 'Changed' }, context))
          .toMatchObject({ ok: false });
        sourceUnavailable = true;
        expect(await execute.execute('skills.read', { skillId }, context))
          .toMatchObject({ ok: false, errorCode: 'skill_content_unavailable' });
        sourceUnavailable = false;
        expect(await execute.execute('skills.read', { skillId: 'plugin:com.acme.absent/check' }, context))
          .toMatchObject({ ok: false, errorCode: 'not_found' });
      });
    } finally {
      await runtime?.dispose(); await sourceSockets?.close(); await app.close(); resetInMemoryAccountSettingsContextForTests();
      env.restore(); reloadConfiguration();
    }
  });

});

