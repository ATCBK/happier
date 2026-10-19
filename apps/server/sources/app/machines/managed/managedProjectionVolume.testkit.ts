import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { expect, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { ManagedAdmissionOutputV1Schema, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import * as prisma from '@/storage/prisma';
import { createAuthenticatedRouteRequest } from '@/app/api/testkit/requestFixtures';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { registerManagedMachineRoutes } from './managedRoutes';
import { resolveManagedDeclarationInTx, type StoredManagedMachine } from './managedRows';

interface QueryMeasurement {
    model: string;
    method: string;
    milliseconds: number;
    bytes: number;
    pluginIds: string[];
}

/** Observe real Prisma I/O; domain logic, query results and transaction options stay intact. */
async function measure<T>(phase: string, operation: () => Promise<T>) {
    const queries: QueryMeasurement[] = [];
    const original = db.$transaction;
    const start = performance.now();
    const observe = (tx: Tx): Tx => new Proxy(tx, {
        get(owner, property, txReceiver) {
            const delegate: unknown = Reflect.get(owner, property, txReceiver);
            if (typeof delegate === 'function') return delegate.bind(owner);
            if (typeof property !== 'string' || !/^[a-z][A-Za-z]+$/.test(property) || !delegate || typeof delegate !== 'object') return delegate;
            return new Proxy(delegate, {
                get(model, method, modelReceiver) {
                    const call: unknown = Reflect.get(model, method, modelReceiver);
                    if (typeof call !== 'function') return call;
                    return async (...input: unknown[]) => {
                        const began = performance.now();
                        const result: unknown = await Reflect.apply(call, model, input);
                        const milliseconds = performance.now() - began;
                        const rows: unknown[] = Array.isArray(result) ? result : [result];
                        queries.push({ model: property, method: String(method), milliseconds,
                            bytes: Buffer.byteLength(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value) ?? ''),
                            pluginIds: rows.flatMap(row => row && typeof row === 'object' && 'pluginId' in row && typeof row.pluginId === 'string' ? [row.pluginId] : []) });
                        return result;
                    };
                },
            });
        },
    });
    const snapshot = prisma.withSqliteReadSnapshot;
    const snapshotObservation = vi.spyOn(prisma, 'withSqliteReadSnapshot').mockImplementation(
        (read, options) => snapshot(tx => read(observe(tx)), options),
    );
    db.$transaction = new Proxy(original, {
        apply(target, receiver, args) {
            const callback: unknown = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
        },
    });
    try {
        return { value: await operation(), queries };
    } finally {
        db.$transaction = original;
        snapshotObservation.mockRestore();
        const elapsedMs = performance.now() - start;
        const queryMs = queries.reduce((sum, query) => sum + query.milliseconds, 0);
        const summarize = (model: string) => {
            const selected = queries.filter(query => query.model === model);
            return { queryMs: selected.reduce((sum, query) => sum + query.milliseconds, 0),
                rows: selected.reduce((sum, query) => sum + query.pluginIds.length, 0),
                bytes: selected.reduce((sum, query) => sum + query.bytes, 0) };
        };
        console.info('managed-projection-volume', JSON.stringify({ phase, elapsedMs, queryMs,
            outsideQueryMs: elapsedMs - queryMs,
            materializations: summarize('pluginMachineMaterialization'),
            intents: summarize('accountPluginIntent'), releases: summarize('accountPluginRelease') }));
    }
}

/** Seed the actual bundled declaration/materialization volume on a disposable controller. */
export async function seedBundledManagedAvailability(accountId: string, homeId: string,
    controller: Readonly<{ machineId: string; installationId: string }>) {
    const pluginsRoot = new URL('../../../../../../packages/plugins/', import.meta.url);
    const manifests = [];
    for (const directory of await readdir(pluginsRoot, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const path = new URL(`${directory.name}/.happier-plugin/plugin.json`, pluginsRoot);
        let source: string;
        try { source = await readFile(path, 'utf8'); }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
            throw error;
        }
        manifests.push(PluginManifestV2Schema.parse(JSON.parse(source)));
    }
    const manifest = manifests.find(candidate => candidate.id === 'happier.machine.lima');
    if (!manifest) throw new Error(`Missing bundled Lima manifest at ${fileURLToPath(pluginsRoot)}`);
    console.info('managed-projection-fixture', JSON.stringify({ plugins: manifests.length,
        manifestBytes: manifests.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) }));
    for (const candidate of manifests) {
        const declaration = createReleaseLessDeclarationV1(candidate);
        await db.accountPluginIntent.create({ data: { accountId, pluginId: candidate.id,
            enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: randomUUID(), pluginId: candidate.id, version: candidate.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    }
    // CREF-1 through CREF-9 are successive runtime generations on one installation,
    // not nine simultaneous full materialization inventories. Exercise the actual replacement owner.
    const availability = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }),
        resolveServerIdentityId: async () => homeId });
    const initialMaterializations = await db.pluginMachineMaterialization.findMany({ where: { machineId: controller.machineId } });
    for (let generation = 1; generation <= 9; generation += 1) {
        expect(await availability.reportMaterializations({ accountId, publisherMachineId: controller.machineId,
            input: { expectedRevision: generation, snapshot: { serverIdentityId: homeId, machineId: controller.machineId,
                materializations: initialMaterializations.map(row => ({ serverIdentityId: homeId, machineId: controller.machineId,
                    materializationId: `${generation}-${row.pluginId}`, pluginId: row.pluginId, version: row.version,
                    sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: row.archiveDigestSha256,
                    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: Date.now() })) } } }))
            .toEqual({ outcome: 'replaced', revision: generation + 1 });
        expect(await db.pluginMachineMaterialization.count({ where: { machineId: controller.machineId } })).toBe(manifests.length);
    }
    return manifest;
}

/** Real bundled manifest volume, real managed HTTP handlers, real disposable storage. */
export async function exerciseManagedProjectionVolume() {
    const homeId = `srv_${'a'.repeat(32)}`;
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const controller = { machineId: randomUUID(), installationId: randomUUID() };
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
        installationId: controller.installationId, pluginMaterializationRevision: 1n } });
    const manifest = await seedBundledManagedAvailability(account.id, homeId, controller);
    const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Volume guest',
        choices: { instance: 'volume-guest', store: '/tmp/volume-guests', image: 'fixture:image', arch: 'x86_64',
            vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] } };
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Authentication is the substituted system boundary; all managed authority checks remain real.
    app.decorate('authenticate', async (request: FastifyRequest) => {
        Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
            externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
            externalActionEffectActionId: 'machines.managed.acquire', externalActionExecutionRequestId: 'volume-create',
            externalActionExecutionRequestEnvelopeDigest: 'volume-admitted-envelope',
            externalActionExecutionCustodianAccountId: account.id }),
        { headers: request.headers, params: request.params, query: request.query });
    });
    registerManagedMachineRoutes(app);
    try {
        const rows: StoredManagedMachine[] = [];
        const lists: Array<{ count: number; value: Awaited<ReturnType<typeof app.inject>>; queries: QueryMeasurement[] }> = [];
        for (const count of [1, 4, 16]) {
            while (rows.length < count) {
                rows.push(await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
                    controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
                    admittedActionRequestId: randomUUID(), admittedInput: {}, launch,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }));
            }
            lists.push({ count, ...await measure(`list-${count}`, () => app.inject({ method: 'POST',
                url: '/v1/machines/managed/actions/list', payload: { homeId } })) });
        }
        const create = await measure('create', () => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: {
            input: { selection: { kind: 'one-off', homeId, controller, launch,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
            requestId: 'volume-create', continuationPresent: false,
        } }));
        const cancel = await measure('cancel', () => app.inject({ method: 'POST', url: '/v1/machines/managed/actions/cancel', payload: {
            homeId, managedId: rows[0].id, expectedIntentRevision: 0,
        } }));
        for (const list of lists) {
            expect(list.value.statusCode, list.value.body).toBe(200);
            expect(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(list.value.json()).machines).toHaveLength(list.count);
        }
        expect(create.value.statusCode, create.value.body).toBe(200);
        expect(ManagedAdmissionOutputV1Schema.parse(create.value.json())).toMatchObject({ replayed: false,
            machine: { allocation: 'unsubmitted', launch } });
        expect(cancel.value.statusCode, cancel.value.body).toBe(200);
        expect(ManagedMachineActionOutputSchemasV1['machines.managed.cancel'].parse(cancel.value.json()))
            .toMatchObject({ machine: { id: rows[0].id, creationState: 'canceled', allocation: 'confirmed-absent' } });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(17);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: rows[0].id } }))
            .toMatchObject({ creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 });
        // Observable resource contract: unrelated plugin manifests must never enter a managed projection.
        // This distinguishes query pushdown from merely discarding unrelated results after loading them.
        for (const result of [...lists, create, cancel]) {
            const fetchedPluginIds = result.queries.flatMap(query => query.pluginIds);
            expect(fetchedPluginIds.length).toBeGreaterThan(0);
            expect([...new Set(fetchedPluginIds)]).toEqual([manifest.id]);
        }
        // Declaration transfer depends on the distinct provider/controller pair, not retained row count.
        const declarationBytes = (queries: QueryMeasurement[]) => queries
            .filter(query => query.model === 'accountPluginIntent' || query.model === 'accountPluginRelease')
            .reduce((sum, query) => sum + query.bytes, 0);
        expect(lists.map(list => declarationBytes(list.queries)))
            .toEqual(lists.map(() => declarationBytes(lists[0].queries)));
        // A retained row from an old installation must not inherit the current
        // installation's declared schema merely because its provider is the same.
        const orphan = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: randomUUID(),
            admittedActionRequestId: randomUUID(), admittedInput: {},
            launch: { ...launch, choices: { retainedOldInstallation: true } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const retained = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list', payload: { homeId } });
        expect(retained.statusCode, retained.body).toBe(200);
        expect(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(retained.json()).machines.find(row => row.id === orphan.id))
            .toMatchObject({ launch: { choices: { retainedOldInstallation: true } } });
        // Filtering and request-local reuse must retain installation, intent and trust currentness.
        const declarationInput = { homeId, custodianAccountId: account.id, controller, provider: launch.provider };
        const declaration = (input = declarationInput) => inReadSnapshot(tx => resolveManagedDeclarationInTx(tx, input));
        expect(await declaration()).toMatchObject({ schemaVersion: 1 });
        expect(await declaration({ ...declarationInput, controller: { ...controller, installationId: randomUUID() } })).toBeNull();
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { enabled: false } });
        expect(await declaration()).toBeNull();
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { enabled: true } });
        await db.pluginMachineMaterialization.updateMany({ where: { machineId: controller.machineId, pluginId: manifest.id }, data: { trustState: 'untrusted' } });
        expect(await declaration()).toBeNull();
        // Re-reading after these writes must not reuse a declaration from a previous request.
        await db.managedMachine.update({ where: { id: rows[0].id }, data: { launch: { ...launch, choices: { retainedUnavailableProvider: true } } } });
        const unavailable = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list', payload: { homeId } });
        expect(unavailable.statusCode, unavailable.body).toBe(200);
        expect(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(unavailable.json()).machines.find(row => row.id === rows[0].id))
            .toMatchObject({ launch: { choices: { retainedUnavailableProvider: true } } });
    } finally {
        await app.close();
    }
}
