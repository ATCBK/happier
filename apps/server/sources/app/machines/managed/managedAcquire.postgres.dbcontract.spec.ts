import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { admitManagedAcquire } from './managedAcquire';
import { createMachinePreset } from './machinePresetService';
import { admitManagedControl, reportManagedAcquire, reportManagedIntent, submitManagedAcquire, submitManagedIntent } from './managedMutations';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('managed admission under PostgreSQL Account contention', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each([
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit' },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'admit' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'report' },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'report' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'submit' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'control' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'intent-submit' },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'intent-report' },
    ] as const)('$phase $selectionKind survives an unrelated $publicationAccount publication', async ({ selectionKind, publicationAccount, phase }) => {
        const homeId = `srv_${'a'.repeat(32)}`;
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', homeId);
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
        const viewer = publicationAccount === 'viewer'
            ? await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } }) : undefined;
        if (viewer) await db.machineAccountGrant.create({ data: { machineId: controller.machineId,
            accountId: viewer.id, createdByAccountId: account.id, accessLevel: 'view' } });
        const publicationAccountId = viewer?.id ?? account.id;
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.admission-contention', version: '1.0.0',
            displayName: 'Admission contention', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const launchSnapshot = { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1,
            name: 'Guest', choices: { image: 'linux' } };
        const retention = { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const };
        const presetId = randomUUID();
        if (selectionKind === 'preset') {
            expect(await createMachinePreset({ accountId: account.id, input: { id: presetId, homeId, name: 'Contended preset',
                owner: { kind: 'account', accountId: account.id }, controller, recipe: launchSnapshot,
                simultaneousLimit: { maximum: 1 } } })).toMatchObject({ kind: 'saved' });
        }
        const request: Parameters<typeof admitManagedAcquire>[0] = {
            custodianAccountId: account.id, requesterAccountId: account.id, requestEnvelopeDigest: 'contention-test',
            input: { requestId: randomUUID(), continuationPresent: false, input: selectionKind === 'one-off'
                ? { selection: { kind: 'one-off', homeId, controller, launch: launchSnapshot, retention, wakeOnAcceptedMessage: true } }
                : { selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller, retention, wakeOnAcceptedMessage: true } },
        };
        const allocated = phase !== 'admit' ? await admitManagedAcquire(request) : undefined;
        const correlation = allocated ? { homeId, managedId: allocated.machine.id, controller,
            requestId: request.input.requestId, expectedIntentRevision: 0 } : undefined;
        const resource = { contributionRef: launchSnapshot.provider, schemaVersion: 1, value: { id: 'native-created-before-report' } };
        if (correlation && phase !== 'submit') await submitManagedAcquire(correlation);
        if (correlation && ['control', 'intent-submit', 'intent-report'].includes(phase)) {
            await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        }
        const control = correlation ? { actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.delete' as const, requestId: randomUUID(), input: { homeId, managedId: correlation.managedId,
                when: 'now' as const, expectedRevision: 0, intent: 'delete' as const, reviewedDependencies: true },
        } } : undefined;
        if (control && ['intent-submit', 'intent-report'].includes(phase)) await admitManagedControl(control);
        const intentCorrelation = correlation && control ? { ...correlation, expectedIntentRevision: 1, requestId: control.input.requestId } : undefined;
        if (intentCorrelation && phase === 'intent-report') await submitManagedIntent(intentCorrelation);
        const { seq: initialSeq } = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        const viewerSeq = viewer ? (await db.account.findUniqueOrThrow({ where: { id: viewer.id }, select: { seq: true } })).seq : 0;
        const originalTransaction = db.$transaction;
        let writer: Promise<unknown> | undefined;
        let writerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        // Interleave only at the real Prisma transport; all domain owners and SQL remain real.
        db.$transaction = new Proxy(originalTransaction, {
            apply(target, thisArg, args) {
                const callback: unknown = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, thisArg, args);
                return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                    const machines = new Proxy(tx.managedMachine, {
                        get(owner, property, receiver) {
                            const method: unknown = Reflect.get(owner, property, receiver);
                            if (property !== (phase === 'admit' ? 'create' : 'updateMany') || typeof method !== 'function') return method;
                            return async (...values: unknown[]) => {
                                let ready!: (pid: number) => void;
                                const started = new Promise<number>(resolve => { ready = resolve; });
                                let settled = false;
                                writer = inTx(async (peer: Tx) => {
                                    const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                    ready(pid);
                                    // The same canonical publication that competes with admission in the live server.
                                    return markAccountChanged(peer, { accountId: publicationAccountId, kind: 'account', entityId: 'unrelated-publication' });
                                }, { isolationLevel: 'ReadCommitted' });
                                writerOutcome = Promise.allSettled([writer!]).finally(() => { settled = true; });
                                const pid = await Promise.race([started, writer!.then(() => { throw new Error('Writer missed rendezvous'); })]);
                                while (!settled) {
                                    const [state] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                                        SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS waiting
                                    `;
                                    if (state.waiting) break;
                                }
                                return Reflect.apply(method, owner, values);
                            };
                        },
                    });
                    return callback(new Proxy(tx, { get(owner, property, receiver) {
                        return property === 'managedMachine' ? machines : Reflect.get(owner, property, receiver);
                    } }));
                }, args[1]]);
            },
        });
        try {
            const admitted = phase === 'report' && correlation ? await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } })
                : phase === 'submit' && correlation ? await submitManagedAcquire(correlation)
                : phase === 'control' && control ? await admitManagedControl(control)
                : phase === 'intent-submit' && intentCorrelation ? await submitManagedIntent(intentCorrelation)
                : phase === 'intent-report' && intentCorrelation ? await reportManagedIntent({ ...intentCorrelation,
                    result: { kind: 'confirmed' }, observation: { observedAt: Date.now(), availability: 'absent' } })
                : await admitManagedAcquire(request);
            await writer;
            expect(admitted).toMatchObject({ machine: { retention, wakeOnAcceptedMessage: true,
                ...(phase === 'report' ? { allocation: 'bound', resource: { value: { id: 'native-created-before-report' } } } : {}),
                ...(phase === 'intent-report' ? { allocation: 'confirmed-absent' } : {}) } });
            expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);
            db.$transaction = originalTransaction;
            expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true, machine: { id: admitted.machine.id } });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: initialSeq + (viewer ? 1 : 2) });
            if (viewer) expect(await db.account.findUniqueOrThrow({ where: { id: viewer.id }, select: { seq: true } })).toEqual({ seq: viewerSeq + 2 });
            if (selectionKind === 'preset') {
                await expect(admitManagedAcquire({ ...request, input: { ...request.input, requestId: randomUUID() } }))
                    .rejects.toMatchObject({ code: 'preset_limit_reached' });
            }
        } finally {
            db.$transaction = originalTransaction;
            if (writerOutcome) for (const outcome of await writerOutcome) if (outcome.status === 'rejected') throw outcome.reason;
            vi.unstubAllEnvs();
            await db.managedMachine.deleteMany({ where: { custodianAccountId: account.id } });
            await db.managedMachinePreset.deleteMany({ where: { custodianAccountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
            if (viewer) await db.account.delete({ where: { id: viewer.id } });
        }
    });
});
