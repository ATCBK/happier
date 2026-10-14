import '../../../../../ui/sources/dev/vitestSetup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { createLightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { eventRouter } from '../../../../../server/sources/app/events/connectionEventRouter';
import { getAccountStoredContentV3SocketRoom } from '../../../../../server/sources/app/api/socketRooms';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '../../../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describeApprovalRequestFields } from '@happier-dev/protocol/actions';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { skillFileFromBytesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1, PROMPT_LIBRARY_ROWS_ROUTE_V1,
  PromptLibraryRowReadResponseV1Schema, openPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

// Only device credential storage and endpoint selection are substituted. Every
// Artifact and entity-row request reaches the real authenticated HTTP/SQLite owners.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('../../../../../ui/sources/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { TokenStorage } = await import('../../../../../ui/sources/auth/storage/tokenStorage');
const { createDefaultActionExecutor } = await import('../../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { setRuntimeFetch } = await import('../../../../../ui/sources/utils/system/runtimeFetch');

describe('CLI skill-rule approval replayed by the app', () => {
  let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-skill-rule-app-replay-', initAuth: true, initEncrypt: true });
  }, 0);
  afterAll(async () => { await homes.reset(); if (sqlite) await sqlite.close(); });

  it.each([false, true])('writes and restores the rule through original Account custody (miswired storage: %s)', async miswired => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_SERVER_UI_DIR', 'HAPPIER_SERVER_UI_REQUIRED']);
    const locks = installWebLockManagerMock();
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../server/sources/app/api/types').Fastify;
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
      accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
      value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
    } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const machineId = 'skill-rule-machine';
    const sockets = new Server(app.server, { path: '/v1/updates' });
    sockets.use((socket, next) => {
      void (async () => {
        const token: unknown = socket.handshake.auth.token;
        const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
        if (verified?.userId !== account.id) return next(new Error('Unauthorized'));
        await socket.join(getAccountStoredContentV3SocketRoom(account.id)); next();
      })().catch(next);
    });
    eventRouter.setIo(sockets);
    let observer: ReturnType<typeof io> | undefined;
    let profileId: string | undefined;
    try {
      env.patch({ HAPPIER_SERVER_UI_DIR: undefined, HAPPIER_SERVER_UI_REQUIRED: '0' });
      enableOptionalStatics(app); accountRoutes(app); artifactsRoutes(app);
      const url = await app.listen({ port: 0, host: '127.0.0.1' });
      env.patch({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/cli-home-${miswired}`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
      reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
      observer = io(url, { path: '/v1/updates', transports: ['websocket'], auth: { token: credentials.token }, reconnection: false });
      await new Promise<void>((resolve, reject) => { observer!.once('connect', resolve); observer!.once('connect_error', reject); });
      const hints: unknown[] = []; observer.on('update', value => hints.push(value));
      const request = (path: string, init?: RequestInit) => fetch(`${url}${path}`, { ...init, headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...Object.fromEntries(new Headers(init?.headers)),
        authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json',
      } });
      profileId = await homes.addHome({ name: 'Skill rules replay', serverUrl: url, accountId: account.id, currentAccount: true });
      vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: credentials.token });
      for (const path of ['/v2/account/settings', '/v1/account/encryption', '/v1/account/encryption/currentness', PROMPT_LIBRARY_ROWS_ROUTE_V1]) {
        homes.answer(profileId, path, { select: async () => {
          const response = await request(path); return { status: response.status, body: await response.json() };
        } });
      }
      const rulePath = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`;
      const ruleWriteStatuses: number[] = [];
      homes.answer(profileId, rulePath, { select: async input => {
        const response = await request(rulePath, { method: 'POST', body: JSON.stringify(miswired ? {} : input) });
        ruleWriteStatuses.push(response.status);
        return { status: response.status, body: await response.json() };
      } });
      setRuntimeFetch(homes.request);
      await runWithServerHttpBaseUrl(url, async () => {
        await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global', mode: 'plain', ctx: null });
        const cli = createActionExecutor(deps);
        const seed = await createActionExecutor({ ...deps, isActionApprovalRequired: () => false }).execute('skills.create', {
          name: 'approval-replay', files: [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: approval-replay\n---\nA rule replay skill.'), 0o644)],
          where: { kind: 'replace', rules: [] },
        }, { surface: 'cli', authority: 'account_automation' });
        expect(seed, JSON.stringify(seed)).toMatchObject({ ok: true });
        if (!seed.ok) throw new Error('Skill seed failed');
        const skill = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(seed.result);
        const input = getActionSpec('skills.rules.set').inputSchema.parse({ items: [{ skillId: skill.skillId }],
          change: { kind: 'write', write: { place: { t: 'machine', machineId }, state: 'on' } } });
        const proposed = await cli.execute('skills.rules.set', input, { surface: 'cli', authority: 'account_automation',
          serverId: profileId, runtimeAccountId: account.id, defaultSessionMachineId: machineId,
          actionCaller: { kind: 'host' }, actionRequestId: `cli-rule-${miswired}` });
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok || typeof proposed.result !== 'object' || !proposed.result || !('artifactId' in proposed.result)
          || typeof proposed.result.artifactId !== 'string') throw new Error('Missing CLI approval');
        const artifactId = proposed.result.artifactId;
        const stored = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
        expect(stored).toMatchObject({ status: 'open', createdBy: { surface: 'cli' }, actionArgs: input,
          executionOriginV1: { machineId } });
        // Forward the app's Artifact persistence boundary to the same real Home
        // used by the CLI. The canonical harness retains platform admission only.
        for (const path of ['/v1/artifacts', ...[artifactId, skill.skillId].flatMap(id => [
          `/v1/artifacts/${id}`, `/v1/artifacts/${id}/recipients`, `/v1/artifacts/${id}/content`,
        ])]) homes.answer(profileId!, path, { select: async input => {
          const response = await request(path, input === null ? undefined : { method: 'POST', body: JSON.stringify(input) });
          return { status: response.status, body: await response.json() };
        } });
        const appExecutor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
        const decided = await appExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId });
        const row = PromptLibraryRowReadResponseV1Schema.parse(await (await request(rulePath)).json());
        if (row.status !== 'present') throw new Error('Rules row unavailable');
        const opened = openPromptLibraryContentV1({ key: 'skill-rules', content: row.content, mode: 'plain', material: null });
        if (opened.status !== 'opened' || opened.record.key !== 'skill-rules') throw new Error('Rules row unreadable');
        const rules = opened.record.value;
        if (miswired) {
          expect(decided).toMatchObject({ ok: true, result: { execution: { result: { ok: false } } } });
          expect(ruleWriteStatuses).toContain(400);
          expect(rules.rules.filter(rule => rule.skillId === skill.skillId)).toEqual([]);
        } else {
          expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
          expect(settled.actionArgs).toEqual(input);
          expect(describeApprovalRequestFields(settled)).toEqual(describeApprovalRequestFields(stored));
          expect(rules.rules.filter(rule => rule.skillId === skill.skillId)).toEqual([expect.objectContaining({ skillId: skill.skillId, enabled: true, target: { t: 'machine', machineId } })]);
          expect(hints.length).toBeGreaterThan(0);
          const again = await appExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId });
          expect(again).toMatchObject({ ok: true, result: { status: 'executed' } });
          await expect(appExecutor.execute('skills.rules.set', { ...input,
            change: { kind: 'write', write: { place: { t: 'machine', machineId }, state: 'inherit' } } }, { surface: 'ui', serverId: profileId }))
            .resolves.toMatchObject({ ok: true, result: { ok: true, items: [{ rules: [] }] } });
          const restored = PromptLibraryRowReadResponseV1Schema.parse(await (await request(rulePath)).json());
          if (restored.status !== 'present') throw new Error('Restored rules row unavailable');
          const content = openPromptLibraryContentV1({ key: 'skill-rules', content: restored.content, mode: 'plain', material: null });
          if (content.status !== 'opened' || content.record.key !== 'skill-rules') throw new Error('Restored rules row unreadable');
          expect(content.record.value.rules.filter(rule => rule.skillId === skill.skillId)).toEqual([]);
        }
      });
    } finally {
      // Retire captured readers and close only this fixture's HTTP keep-alives
      // before Socket.IO waits for its shared HTTP server to shut down.
      await homes.reset();
      observer?.disconnect(); app.server.closeAllConnections(); await sockets.close(); await app.close();
      vi.restoreAllMocks(); locks.restore(); env.restore(); reloadConfiguration();
      resetInMemoryAccountSettingsContextForTests();
    }
  });
});
