import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createLightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { registerPluginAvailabilityRoutes } from '../../../../../server/sources/app/plugins/availability/routes';
import { registerAccountSecurityRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { configuration, reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '../createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { skillFileFromBytesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

// Real authenticated HTTP, SQLite, CLI composition, approval Artifacts, rule CAS
// and Session metadata writes. No internal domain service is substituted.
// The proposing waiter detaches before a different client replays durable intent.
describe('Session skill creation through durable approval replay', () => {
  let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-d26-replay-', initAuth: true, initEncrypt: true });
  }, 0);
  afterAll(async () => { if (sqlite) await sqlite.close(); });

  it.each(['approved', 'waived', 'explicit', 'receipt', 'rules-receipt'] as const)('retains creating Session intent for %s install', async mode => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../server/sources/app/api/types').Fastify;
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1, terminalPresentUserPolicy: 'allowed' } });
      for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
        accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
        value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
      } });
      const seedMetadata = createTestMetadata({ machineId: 'machine', path: '/project',
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } } });
      const owner = createSessionOwnerMetadataV1({ metadata: seedMetadata });
      if (!owner.ok) throw new Error('Invalid canonical Session fixture');
      const session = await db.session.create({ data: { accountId: account.id, tag: `d26-${mode}`, encryptionMode: 'plain', active: false,
        metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: seedMetadata })),
        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)) } });
      const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' }),
        credentialProvenance: 'stored_session' as const, encryption: null };
      accountRoutes(app); artifactsRoutes(app); sessionRoutes(app); registerPluginAvailabilityRoutes(app); registerAccountSecurityRoutes(app);
      const serverIdentityId = await initializeServerIdentityCache(); featuresRoutes(app);
      if (!serverIdentityId) throw new Error('Missing Home identity');
      const url = await app.listen({ port: 0, host: '127.0.0.1' });
      env.patch({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/${mode}`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
      reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
      runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['codex'] } });
      await runWithServerHttpBaseUrl(url, async () => {
        await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
        const coordinator = createBlockingApprovalCoordinator();
        onTestFinished(() => coordinator.dispose());
        const proposerLifetime = new AbortController();
        let waiterReady!: () => void;
        const ready = new Promise<void>(resolve => { waiterReady = resolve; });
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: session.id, mode: 'plain', ctx: null,
          serverHttpBaseUrl: url });
        const executor = createActionExecutor({ ...deps, ...(mode === 'waived' || mode === 'rules-receipt' ? { isActionApprovalRequired: () => false } : {}),
          approvalsWaitForDecision: async args => {
            const pending = coordinator.waitForDecision(args); waiterReady();
            const decision = await pending;
            return { ...decision, request: ApprovalRequestV2Schema.parse(decision.request) };
          },
        });
        const pending = executor.execute('skills.install', { source: { kind: 'upload', files: [
          skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: replay-skill\n---\nA harmless fixture.'), 0o644),
        ] }, ...(mode === 'explicit' ? { where: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen-machine' }, state: 'on' } } } : {}) }, {
          surface: 'mcp', authority: 'account_automation', serverId: deps.skillRules!.serverId, serverIdentityId, runtimeAccountId: account.id,
          defaultSessionId: session.id, actionRequestId: `d26-${mode}`,
          signal: proposerLifetime.signal,
          actionCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
        });
        void pending.catch(() => {});
        if (mode === 'waived' || mode === 'rules-receipt') {
          const proposed = await pending;
          expect(proposed.ok, proposed.ok ? undefined : proposed.errorCode).toBe(true);
          if (!proposed.ok) throw new Error(`Install refused: ${proposed.errorCode}`);
          const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(proposed.result);
          if (!('skillIds' in receipt)) throw new Error('Missing install receipt');
          expect(receipt.incomplete).toBeUndefined();
        } else {
          const admission = await Promise.race([ready.then(() => 'waiting' as const), pending.then(result => result.ok ? 'completed' : result.errorCode)]);
          expect(admission).toBe('waiting');
          const inventory = await db.artifact.findMany({ where: { accountId: account.id }, select: { id: true } });
          const artifactId = inventory[0]?.id;
          if (!artifactId) throw new Error('Missing approval Artifact');
          expect(ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId })).executionOriginV1)
            .toMatchObject({ caller: { kind: 'session', sessionId: session.id } });
          // Detached originals retain durable approval intent, not a live result
          // recipient. The other client must execute without this process's waiter.
          if (mode !== 'receipt') {
            proposerLifetime.abort();
            await pending;
          }
          const decidingExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
            serverApiUrl: url, serverIdentityId, readCredentials: async () => credentials });
          const decided = await decidingExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
            surface: 'cli', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
          if (!decided.ok) throw new Error(`Decision refused: ${decided.errorCode}`);
          expect(decided, settled.execution?.errorCode).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          if (mode === 'receipt') {
            // The real cross-device Artifact receipt, not the deciding host's
            // private return value, resumes the original Session tool call.
            coordinator.notifyApprovalUpdated({ artifactId, request: settled });
            const received = await pending;
            expect(received.ok).toBe(true);
            if (!received.ok) throw new Error(received.errorCode);
            const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(received.result);
            if (!('skillIds' in receipt)) throw new Error('Missing install receipt');
            expect(receipt.skillIds).toHaveLength(1);
            expect(receipt.incomplete).toBeUndefined();
          }
        }
        const listed = await executor.execute('skills.list', {}, { surface: 'ui', authority: 'present_user' });
        if (!listed.ok) throw new Error(`Library read refused: ${listed.errorCode}`);
        const items = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.result).items.filter(item => item.name === 'replay-skill');
        expect(items).toHaveLength(1);
        const item = items[0]!;
        if (mode === 'rules-receipt') {
          let rulesArtifactId: string | undefined;
          let rulesReady!: () => void;
          const rulesWaiting = new Promise<void>(resolve => { rulesReady = resolve; });
          const rulesExecutor = createActionExecutor({ ...deps,
            approvalsWaitForDecision: args => {
              rulesArtifactId = args.artifactId;
              const waiting = coordinator.waitForDecision(args);
              rulesReady();
              return waiting.then(decision => ({ ...decision, request: ApprovalRequestV2Schema.parse(decision.request) }));
            },
          });
          const rulesPending = rulesExecutor.execute('skills.rules.set', {
            items: [{ skillId: item.skillId }],
            change: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen-machine' }, state: 'on' } },
          }, { surface: 'mcp', authority: 'account_automation', serverId: deps.skillRules!.serverId,
            serverIdentityId, runtimeAccountId: account.id, defaultSessionId: session.id,
            actionRequestId: 'rules-receipt', actionCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } });
          await rulesWaiting;
          if (!rulesArtifactId) throw new Error('Missing rules approval');
          const decidingExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
            serverApiUrl: url, serverIdentityId, readCredentials: async () => credentials });
          await decidingExecutor.execute('approval.request.decide', { artifactId: rulesArtifactId, decision: 'approve' }, {
            surface: 'cli', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId: rulesArtifactId }));
          coordinator.notifyApprovalUpdated({ artifactId: rulesArtifactId, request: settled });
          const received = await rulesPending;
          expect(received.ok).toBe(true);
          if (!received.ok) throw new Error(received.errorCode);
          const receipt = getActionSpec('skills.rules.set').outputSchema!.parse(received.result);
          expect(receipt).toMatchObject({ ok: true, items: [{ skillId: item.skillId, previous: [],
            rules: [expect.objectContaining({ target: { t: 'machine', machineId: 'chosen-machine' }, enabled: true })] }] });
          // Public observation must remain redacted even when private receipt
          // custody retains the complete schema-valid result for its requester.
          const observed = await decidingExecutor.execute('approval.request.get', { artifactId: rulesArtifactId }, {
            surface: 'cli', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          expect(observed).toMatchObject({ ok: true, result: { request: { execution: { result: {
            ok: true, itemIds: [item.skillId],
          } } } } });
          expect(JSON.stringify(observed)).not.toContain('previous');
        }
        const raw = await fetchSessionById({ token: credentials.token, sessionId: session.id });
        if (!raw) throw new Error('Missing Session');
        const metadata = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession: raw });
        const selection = readSessionCapabilitySelectionFromMetadataV1(metadata);
        if (mode === 'explicit') {
          expect(item?.rules).toEqual([expect.objectContaining({ target: { t: 'machine', machineId: 'chosen-machine' }, enabled: true })]);
          expect(selection.skills.forceIncludeSkillIds).toEqual([]);
        } else {
          expect(item?.rules).toEqual([]);
          expect(selection.skills.forceIncludeSkillIds).toEqual([item.skillId]);
        }
      });
    } finally {
      await runtime?.dispose(); await app.close(); env.restore(); reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
    }
  });
});
