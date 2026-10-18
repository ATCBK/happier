import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { authRoutes } from './authRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { machinesRoutes } from '../machines/machinesRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { createFileHomeConnectionDescriptorContinuityStore } from '@/app/features/homeConnectionDescriptorContinuity';
import { readHomeConnectionDescriptor } from '@/app/features/homeConnectionDescriptorPublication';
import { seedCliTokenOnlyAuthForServer, seedCliDataKeyAuthForServer } from '../../../../../../../packages/tests/src/testkit/cliAuth';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import tweetnacl from 'tweetnacl';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { terminateProcessTreeByPid } from '../../../../../../../packages/tests/src/testkit/process/processTree';

describe('remote managed enrollment through real CLI processes and Home', () => {
    let harness: LightSqliteHarness;
    const requests: Array<{ path: string; status: number }> = [];
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-qb73-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_qb73_home' } });
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        app.addHook('onResponse', async (request, reply) => { requests.push({ path: request.url.split('?')[0]!, status: reply.statusCode }); });
        enableAuthentication(app);
        authRoutes(app); machinesRoutes(app); registerAccountEncryptionRoutes(app); registerAccountProfileRoute(app);
        featuresRoutes(app, { homeConnectionDescriptorContinuityStore: createFileHomeConnectionDescriptorContinuityStore(join(harness.baseDir, 'descriptor.json')) });
        await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);
    afterAll(async () => { await app.close(); if (harness) await harness.close(); });

    it.each(['current', 'current-e2ee', 'retired', 'misbound-approval'] as const)('enrolls only the current exact admission (%s)', async admission => {
        const succeeds = admission === 'current' || admission === 'current-e2ee';
        requests.length = 0;
        const beforeRequests = await db.terminalAuthRequest.count();
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('missing test listener');
        const endpoint = `http://127.0.0.1:${address.port}`;
        // Distinct canonical audience and application route, as in the QA forward.
        process.env.HAPPIER_CANONICAL_SERVER_URL = `http://localhost:${address.port}`;
        process.env.HAPPIER_PUBLIC_SERVER_URL = endpoint;
        const descriptor = await readHomeConnectionDescriptor({ visibility: 'authenticated',
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(join(harness.baseDir, 'descriptor.json')) });
        expect(descriptor).toBeDefined();
        const contentKeys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: admission === 'current-e2ee'
            ? { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(contentKeys.publicKey) }
            : { encryptionMode: 'plain' } });
        const token = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const controllerHome = join(harness.baseDir, `controller-${admission}`);
        const guestHome = join(harness.baseDir, `guest-${admission}`);
        await mkdir(guestHome, { recursive: true });
        const seeded = admission === 'current-e2ee'
            ? await seedCliDataKeyAuthForServer({ cliHome: controllerHome, serverUrl: endpoint, token, machineKey: contentKeys.secretKey })
            : await seedCliTokenOnlyAuthForServer({ cliHome: controllerHome, serverUrl: endpoint, token });
        const settingsPath = join(controllerHome, 'settings.json');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        settings.servers[seeded.serverId].homeConnectionDescriptor = descriptor;
        await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
        const controller = { machineId: seeded.machineId, installationId: randomUUID() };
        const controllerKeys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
            installationPublicKey: Buffer.from(controllerKeys.publicKey), pluginMaterializationRevision: BigInt(1), metadata: '{}' } });
        const launch = defineProtocolObject({}, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.compute', version: '1.0.0', displayName: 'Enrollment fixture',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: descriptor!.homeServerIdentityId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const resource = { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, value: { id: 'retained' } };
        const row = await db.managedMachine.create({ data: { homeId: descriptor!.homeServerIdentityId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: admission === 'retired' ? 'canceled' : 'active',
            resource, launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const root = fileURLToPath(new URL('../../../../../../../', import.meta.url));
        const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolveResult, reject) => {
            const runtime = process.env.HAPPIER_TEST_REMOTE_ENROLLMENT_RUNTIME ?? process.execPath;
            const child = spawn(runtime, ['--conditions=happier-source', ...(runtime === process.execPath ? ['--import', 'tsx'] : []),
                resolve(root, 'apps/cli/src/testkit/process/fixtures/remoteEnrollmentController.ts')], {
                cwd: resolve(root, 'apps/cli'), stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, DATABASE_URL: undefined, DATABASE_URL_DIRECT: undefined,
                    HAPPIER_HOME_DIR: controllerHome, HAPPIER_SERVER_URL: endpoint,
                    TSX_TSCONFIG_PATH: resolve(root, 'apps/cli/tsconfig.json') },
            });
            const stdout: Buffer[] = [], stderr: Buffer[] = [];
            onTestFinished(async context => {
                if (context.task.result?.state === 'fail') console.log({ requests, controllerOutput: Buffer.concat(stdout).toString('utf8'), controllerError: Buffer.concat(stderr).toString('utf8') });
                if (child.exitCode === null && child.pid) await terminateProcessTreeByPid(child.pid);
            });
            child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
            child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
            child.on('error', reject);
            child.on('close', status => resolveResult({ status: status ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
            child.stdin.end(JSON.stringify({ descriptor, guestHome, guestEntrypoint: process.env.HAPPIER_TEST_REMOTE_ENROLLMENT_ENTRYPOINT,
                guestExecutable: process.env.HAPPIER_TEST_REMOTE_ENROLLMENT_EXECUTABLE,
                misbind: admission === 'misbound-approval', correlation: { homeId: descriptor!.homeServerIdentityId,
                managedId: row.id, requestId: row.admittedActionRequestId, expectedIntentRevision: row.intentRevision, controller, resource } }));
        });
        expect(result.stdout, JSON.stringify(requests)).toContain(succeeds ? '"ok":true' : admission === 'retired' ? 'auth wait' : 'approval_wiring_failed');
        expect(result.status, result.stdout).toBe(succeeds ? 0 : 1);
        if (admission !== 'misbound-approval') {
            const outcome = JSON.parse(result.stdout);
            expect(outcome.task.ok).toBe(succeeds);
            expect(outcome.operation.state).toBe(succeeds ? 'succeeded' : 'failed');
            if (admission === 'retired') expect(outcome.operation.error.error).toMatch(/auth wait \(exit 1; code ERR_BAD_REQUEST; category http_error; HTTP 409\)/u);
        }
        const pending = await db.terminalAuthRequest.findMany();
        expect(pending).toHaveLength(beforeRequests + 1);
        const ownPending = pending.find(request => request.responseAccountId === account.id);
        if (admission === 'misbound-approval') expect(ownPending).toBeUndefined();
        else {
            expect(ownPending).toBeDefined();
            expect(ownPending?.claimedAt).not.toBeNull();
        }
        expect(await db.machine.count({ where: { accountId: account.id } })).toBe(succeeds ? 2 : 1);
        const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        if (succeeds) expect(retained.enrolledMachineId).toEqual(expect.any(String));
        else expect(retained.enrolledMachineId).toBeNull();
    }, 600_000);
});
