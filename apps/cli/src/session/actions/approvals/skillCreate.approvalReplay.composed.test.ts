import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '../createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { skillFileFromBytesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

// Real authenticated HTTP, SQLite, CLI composition, approval Artifacts, rule CAS
// and Session metadata writes. No internal domain or transport is substituted.
describe('Session skill creation through durable approval replay', () => {
  let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-d26-replay-', initAuth: true, initEncrypt: true });
  }, 0);
  afterAll(async () => { if (sqlite) await sqlite.close(); });

  it.each(['approved', 'waived', 'explicit'] as const)('retains creating Session intent for %s install', async mode => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../server/sources/app/api/types').Fastify;
    try {
      const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
      for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
        accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
        value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
      } });
      const session = await db.session.create({ data: { accountId: account.id, tag: `d26-${mode}`, encryptionMode: 'plain', active: false,
        metadata: JSON.stringify(await createTestMetadata({ machineId: 'machine', path: '/project' })) } });
      const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
      accountRoutes(app); artifactsRoutes(app); sessionRoutes(app);
      await initializeServerIdentityCache(); featuresRoutes(app);
      const url = await app.listen({ port: 0, host: '127.0.0.1' });
      env.patch({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/${mode}`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
      reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
      await runWithServerHttpBaseUrl(url, async () => {
        await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: session.id, mode: 'plain', ctx: null,
          serverHttpBaseUrl: url });
        const executor = createActionExecutor({ ...deps, ...(mode === 'waived' ? { isActionApprovalRequired: () => false } : {}) });
        const proposed = await executor.execute('skills.install', { source: { kind: 'upload', files: [
          skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: replay-skill\n---\nA harmless fixture.'), 0o644),
        ] }, ...(mode === 'explicit' ? { where: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen-machine' }, state: 'on' } } } : {}) }, {
          surface: 'mcp', authority: 'account_automation', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
          defaultSessionId: session.id, actionRequestId: `d26-${mode}`,
          actionCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
        });
        let output: unknown;
        if (mode === 'waived') {
          expect(proposed.ok).toBe(true);
          if (!proposed.ok) throw new Error(`Install refused: ${proposed.errorCode}`);
          output = proposed.result;
        } else {
          expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
          if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
            || typeof proposed.result.artifactId !== 'string') throw new Error('Missing approval');
          const artifactId = proposed.result.artifactId;
          expect(ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId })).executionOriginV1)
            .toMatchObject({ caller: { kind: 'session', sessionId: session.id } });
          const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
            surface: 'ui', authority: 'present_user', serverId: deps.skillRules!.serverId, runtimeAccountId: account.id,
            actionCaller: { kind: 'host' },
          });
          expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
          output = settled.execution?.result;
        }
        const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(output);
        if (!('skillIds' in receipt)) throw new Error('Missing install receipt');
        const listed = await executor.execute('skills.list', {}, { surface: 'ui', authority: 'present_user' });
        if (!listed.ok) throw new Error(`Library read refused: ${listed.errorCode}`);
        const item = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.result).items.find(item => item.skillId === receipt.skillIds[0]);
        const raw = await fetchSessionById({ token: credentials.token, sessionId: session.id });
        if (!raw) throw new Error('Missing Session');
        const metadata = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession: raw });
        const selection = readSessionCapabilitySelectionFromMetadataV1(metadata);
        if (mode === 'explicit') {
          expect(item?.rules).toEqual([expect.objectContaining({ target: { t: 'machine', machineId: 'chosen-machine' }, enabled: true })]);
          expect(selection.skills.forceIncludeSkillIds).toEqual([]);
        } else {
          expect(item?.rules).toEqual([]);
          expect(selection.skills.forceIncludeSkillIds).toEqual(receipt.skillIds);
          expect(receipt.includedInSessionId).toBe(session.id);
        }
      });
    } finally {
      await app.close(); env.restore(); reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
    }
  });
});
