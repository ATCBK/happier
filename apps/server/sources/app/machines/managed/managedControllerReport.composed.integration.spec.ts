import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import type { LimaExecutor } from '@happier-dev/cli-common/machineLima';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedAdmissionOutputV1Schema, ManagedControllerSubmitOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { db, initDbPostgres } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { snapshotEnv, restoreEnv } from '@/testkit/env';
import { seedBundledManagedAvailability } from './managedProjectionVolume.testkit';
import { managedQb56Input } from '@/app/api/routes/actions/managedQb56Input.testkit';

// Runtime-loaded cross-package ports keep server compilation inside its root;
// implementations and their own alias/source resolution stay real.
interface ControllerClient {
    post(path: string, body: unknown, schema: typeof ManagedAdmissionOutputV1Schema): Promise<ReturnType<typeof ManagedAdmissionOutputV1Schema.parse>>;
    submit(machine: ManagedMachineV1): Promise<ReturnType<typeof ManagedControllerSubmitOutputV1Schema.parse>>;
    reportIssuedAcquireFact(machine: ManagedMachineV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>): Promise<ManagedMachineV1>;
}

describe('managed native report through CLI, HTTP and disposable storage', () => {
    const homeId = managedQb56Input.selection.homeId;
    const initialEnv = snapshotEnv();
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            if (process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) throw new Error('Use only the disposable PostgreSQL harness');
            Object.assign(process.env, { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HANDY_MASTER_SECRET: randomUUID() });
            initDbPostgres();
            await db.$connect();
            await auth.init();
        } else {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-report-', initAuth: true,
                env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
        }
    }, 120_000);
    afterAll(async () => {
        try { if (harness) await harness.close(); else await db.$disconnect(); }
        finally { restoreEnv(initialEnv); }
    });

    it('persists the real Lima Acquire result before enrollment, replays admission and reports to shared recipients', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            active: true, pluginMaterializationRevision: 1n, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        await db.machineAccountGrant.create({ data: { machineId: controller.machineId, accountId: viewer.id,
            createdByAccountId: account.id, accessLevel: 'view' } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller);
        const definition = manifest.contributes?.machineProvisioners?.find(entry => entry.id === 'lima');
        if (!definition) throw new Error('Bundled Lima provisioner missing');
        const requestId = randomUUID();
        const launch = { ...managedQb56Input.selection.launch, name: 'happier-qb79-defaults',
            choices: { ...managedQb56Input.selection.launch.choices, instance: 'happier-qb79-defaults' } };
        const input = { ...managedQb56Input, selection: { ...managedQb56Input.selection, controller, launch },
            reviewedFacts: { ...managedQb56Input.reviewedFacts, controller, launch } };
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        enableAuthentication(app as Parameters<typeof enableAuthentication>[0]);
        registerExternalActionRoutes(app as Parameters<typeof registerExternalActionRoutes>[0], {
            dispatch: async () => { throw new Error('The report must not dispatch another Action'); },
        });
        machinesRoutes(app as Parameters<typeof machinesRoutes>[0]);
        const { installAxiosFastifyAdapter } = await vi.importActual<{
            installAxiosFastifyAdapter(params: { app: typeof app; origin: string }): () => void;
        }>('../../../../../cli/src/testkit/http/axiosAdapter');
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'http://managed-report.test' });
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId, target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const { createManagedMachineControllerClient } = await vi.importActual<{
                createManagedMachineControllerClient(input: unknown, options: unknown, action: string): ControllerClient;
            }>('../../../../../cli/src/machines/managed/acquire');
            const { createResolvedContributionRegistry } = await vi.importActual<{
                createResolvedContributionRegistry(input: unknown): unknown;
            }>('../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry');
            const client = createManagedMachineControllerClient({ token, serverUrl: 'http://managed-report.test', homeId, controller,
                externalActionMachineRequestPrivateKey: keys.secretKey,
                runtimeRegistry: { contributes: createResolvedContributionRegistry({ machineProvisioners: [{ pluginId: manifest.id,
                    identity: { pluginId: manifest.id, localId: definition.id }, definition }] }) } },
                { requestId, context: { surface: 'cli', externalActionExecutionAuthorization: authorization,
                    externalActionTarget: authorization.binding.target } }, 'machines.managed.acquire');
            const admissionBody = { input, continuationPresent: false, requestId };
            const admitted = await client.post('/v1/machines/managed/controller/admit', admissionBody, ManagedAdmissionOutputV1Schema);
            expect(admitted).toMatchObject({ replayed: false, machine: { allocation: 'unsubmitted' } });
            expect(await client.post('/v1/machines/managed/controller/admit', admissionBody, ManagedAdmissionOutputV1Schema))
                .toMatchObject({ replayed: true, machine: { id: admitted.machine.id } });
            expect(await client.submit(admitted.machine)).toMatchObject({ submitted: true, machine: { allocation: 'may-exist' } });

            // Only native process execution is substituted; the actual Lima leaf
            // produces the resource consumed by the CLI and declared server schema.
            const { createLimaProvider } = await vi.importActual<{
                createLimaProvider(executor: LimaExecutor, observedAt: number, qemuAvailable: () => Promise<boolean>): {
                    acquire(launch: unknown): Promise<unknown>;
                };
            }>('../../../../../../packages/plugins/machine-lima/src/machine/provider');
            let present = false;
            const native = { name: launch.choices.instance, dir: `${launch.choices.store}/${launch.choices.instance}`, status: 'Running',
                vmType: 'qemu', arch: 'x86_64', cpus: 1, memory: 1_073_741_824, disk: 4_294_967_296,
                config: { images: [{ location: launch.choices.image, arch: 'x86_64' }], mounts: [],
                    ssh: { forwardAgent: false }, containerd: { user: false, system: false } } };
            const capture: LimaExecutor['capture'] = async (_command, args) => ({ exitCode: 0, err: '',
                out: args[0] === 'info' ? JSON.stringify({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] })
                    : present ? JSON.stringify(native) : '' });
            const executor: LimaExecutor = { capture, run: async (_command, args) => {
                if (args[0] !== 'create') throw new Error('Unexpected native effect');
                present = true;
                return { exitCode: 0, out: '', err: '' };
            } };
            const fact = AcquireResultV1Schema.parse(await createLimaProvider(executor, Date.now(), async () => true).acquire(launch.choices));
            if (fact.kind !== 'bound') throw new Error(`Lima did not bind: ${fact.kind}`);
            const before = await db.account.findMany({ where: { id: { in: [account.id, viewer.id] } }, select: { id: true, seq: true } });
            const reported = await client.reportIssuedAcquireFact(admitted.machine, fact);
            expect(reported).toMatchObject({ id: admitted.machine.id, allocation: 'bound', resource: fact.resource });
            expect(reported.enrolledMachineId).toBeUndefined();
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: reported.id } }))
                .toMatchObject({ allocation: 'bound', resource: fact.resource, enrolledMachineId: null });
            for (const recipient of before) {
                expect(await db.account.findUniqueOrThrow({ where: { id: recipient.id }, select: { seq: true } })).toEqual({ seq: recipient.seq + 1 });
            }
            expect(await db.accountChange.findMany({ where: { entityId: reported.id }, select: { accountId: true }, orderBy: { accountId: 'asc' } }))
                .toEqual([account.id, viewer.id].sort().map(accountId => ({ accountId })));
            expect(await client.reportIssuedAcquireFact(admitted.machine, fact)).toMatchObject({ id: reported.id, resource: fact.resource });
            expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(0);
        } finally { restoreHttp(); await app.close(); }
    }, 120_000);
});
