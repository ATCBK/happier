import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { enqueuePendingMessage, updatePendingRequestedAction } from '../../../../server/sources/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { readManagedWakeTargets } from '../../../../server/sources/app/machines/managed/managedWake';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createPendingSessionActivationRecovery } from './pendingSessionActivationRecovery';
import { activatePendingInactiveSession } from './activatePendingInactiveSession';

describe('managed Pending rearm through Home and daemon reconnect', () => {
  let database: LightSqliteHarness;
  beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-pending-recovery-', initAuth: true,
      env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
  }, 120_000);
  afterAll(async () => { if (database) await database.close(); });

  it('keeps an accepted guest wake available when another owner daemon scans a Session without resume metadata', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const machine = (accountId: string, active: boolean) => db.machine.create({ data: {
      id: randomUUID(), accountId, installationId: randomUUID(), active,
      metadata: encodePlainMachineStoredContent({ host: 'wake-fixture', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier' }),
      installationPublicKey: tweetnacl.sign.keyPair().publicKey,
      dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
      operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
    } });
    const controller = await machine(custodian.id, true);
    const guest = await machine(custodian.id, false);
    const other = await machine(owner.id, true);
    for (const target of [controller, guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
      actorAccountId: custodian.id, machineId: target.id, principal: { kind: 'account', accountId: owner.id }, level: 'admin',
    }));
    const managed = await db.managedMachine.create({ data: {
      homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
      controllerInstallationId: controller.installationId!, enrolledMachineId: guest.id,
      admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
      encryptionMode: 'plain', active: false } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: owner.id,
      sessionId: session.id, machineId: guest.id, data: 'fixture-encrypted-key' }))).toMatchObject({ ok: true });
    const input = { actorUserId: owner.id, authentication: createPresentUserSessionAccessAuthentication(),
      sessionId: session.id, localId: randomUUID(), targetMachineId: guest.id,
      requestedAction: { v: 1, kind: 'enqueue' },
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained original input' } } } } as const;
    expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
    expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true });
    const census = () => readManagedWakeTargets({ actorAccountId: custodian.id,
      request: { homeId, controller: { machineId: controller.id, installationId: controller.installationId! } } });
    expect((await census()).targets).toMatchObject([{ managedId: managed.id }]);
    const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    const credentials = { token: await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerSessionListingRoutes(app); sessionPendingRoutes(app); registerAccountEncryptionRoutes(app);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    const results: Awaited<ReturnType<typeof activatePendingInactiveSession>>[] = [];
    try {
      for (const machineId of [other.id, controller.id]) {
        const recovery = createPendingSessionActivationRecovery({ token: credentials.token,
          activate: async hint => { results.push(await activatePendingInactiveSession({ credentials,
            machineId, sessionId: hint.sessionId, requestId: hint.requestId, pendingVersion: hint.pendingVersion,
            spawnSessionForInternalResume: async () => { throw new Error('Foreign daemon must not spawn the guest'); } })); },
          warn: (_message, _hint, error) => { throw error; },
        });
        await recovery.recoverAfterConnect();
      }
      expect(results).toEqual([
        { status: 'not-needed', reason: 'target-mismatch' }, { status: 'not-needed', reason: 'target-mismatch' },
      ]);
      const after = await db.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(after.pendingActivationStatus).toBe('waiting');
      expect(after.pendingActivationRequestedAt).toEqual(before.pendingActivationRequestedAt);
      expect((await census()).targets).toMatchObject([{ managedId: managed.id,
        origin: { pendingRequestId: input.localId, requestedAt: before.pendingActivationRequestedAt!.getTime() } }]);
      expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
        .toMatchObject([{ localId: input.localId, status: 'queued' }]);
      // Even an exact-guest runtime report cannot settle compute's pending
      // wake. Once compute runs, its genuine metadata refusal can settle it.
      expect(await activatePendingInactiveSession({ credentials, machineId: guest.id,
        sessionId: session.id, requestId: input.localId, pendingVersion: before.pendingVersion,
        spawnSessionForInternalResume: async () => { throw new Error('Missing resume metadata must not spawn'); } }))
        .toMatchObject({ status: 'not-needed', reason: 'authorization-stale' });
      expect((await census()).targets).toMatchObject([{ managedId: managed.id }]);
      await db.managedMachine.update({ where: { id: managed.id }, data: {
        observation: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' },
      } });
      expect(await activatePendingInactiveSession({ credentials, machineId: guest.id,
        sessionId: session.id, requestId: input.localId, pendingVersion: before.pendingVersion,
        spawnSessionForInternalResume: async () => { throw new Error('Missing resume metadata must not spawn'); } }))
        .toMatchObject({ status: 'rejected', reason: 'identity-unavailable' });
      expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
        .toMatchObject({ pendingActivationStatus: 'failed' });
      expect((await census()).targets).toEqual([]);
    } finally { restore(); await app.close(); }
  });
});
