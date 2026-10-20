import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, MachineOperationProtocolCapabilitiesV1Schema,
    ManagedAcquireInputV1Schema,
} from '@happier-dev/protocol';
import { ExternalActionResponseEnvelopeV1Schema, ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { seedBundledManagedAvailability } from '@/app/machines/managed/managedProjectionVolume.testkit';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { managedQb56Input } from './managedQb56Input.testkit';

// QB87's credential-free prepared.json, 2026-10-18T21:57:13.304Z. Only
// compute name/size differ from the existing QB56 capture; identities match.
const requestId = '4da26e14-aaf6-44e5-b8e7-e5f328176206';
const launch = { ...managedQb56Input.selection.launch, name: 'happier-qb87-defaults',
    choices: { ...managedQb56Input.selection.launch.choices, instance: 'happier-qb87-defaults',
        cpus: 2, memoryGiB: 4, diskGiB: 16 } };
const input = ManagedAcquireInputV1Schema.parse({ ...managedQb56Input,
    selection: { ...managedQb56Input.selection, launch },
    reviewedFacts: { ...managedQb56Input.reviewedFacts, launch,
        nativeFacts: { ...managedQb56Input.reviewedFacts?.nativeFacts,
            size: { id: '2/4/16', title: 'happier-qb87-defaults', cpuCores: 2,
                memoryBytes: 4_294_967_296, diskBytes: 17_179_869_184 } } } });

describe('QB87 Create admission through the real Home route', () => {
    let harness: LightSqliteHarness;
    const homeId = managedQb56Input.selection.homeId;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-qb93-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('admits the captured 2 CPU / 4 GiB / 16 GiB request and returns a typed controller refusal', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = managedQb56Input.selection.controller;
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            active: true, pluginMaterializationRevision: 1n, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        await seedBundledManagedAvailability(account.id, homeId, controller);
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        enableAuthentication(instance);
        let reachedController = false;
        registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
            // Only the daemon transport is substituted. Admission and storage remain real.
            forwardRpc: async () => { reachedController = true; return { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' }; } }) });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, requestId, target: { kind: 'machine', machineId: controller.machineId }, input } });
            expect(response.statusCode, response.body).toBe(200);
            const body = ExternalActionResponseEnvelopeV1Schema.parse(response.json());
            expect(body).toMatchObject({ requestId, actionId: 'machines.managed.acquire',
                execution: { ok: false, errorCode: 'target_unavailable' } });
            expect(reachedController).toBe(true);
            expect(await db.managedMachine.findFirst({ where: { homeId, admittedActionRequestId: requestId } }))
                .toMatchObject({ allocation: 'unsubmitted', creationState: 'active', intentRevision: 0 });
            // Inject at the persistent database boundary; route, dispatcher,
            // admission, retained-row lookup and strict response reader stay real.
            const findUnique = db.managedMachine.findUnique.bind(db.managedMachine);
            for (const [id, code] of [
                ['qb94-new-admission', 'action_not_admitted'],
                [requestId, 'action_outcome_unknown'],
                ['qb94-unavailable-witness', 'action_outcome_unknown'],
            ]) {
                const records: unknown[] = [];
                const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
                const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
                const failure = Object.assign(new TypeError('private-database-message'), {
                    code: 'EIO', stack: 'TypeError: private-database-message\n    at privateDriver (/srv/happier/admission.ts:42:9)',
                });
                const read = vi.spyOn(db.managedMachine, 'findUnique').mockImplementation(findUnique).mockRejectedValueOnce(failure);
                if (id === 'qb94-unavailable-witness') read.mockRejectedValueOnce(new Error('private-witness-unavailable'));
                try {
                    reachedController = false;
                    const failed = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                        headers: { authorization: `Bearer ${token}` },
                        payload: { v: 1, requestId: id, target: { kind: 'machine', machineId: controller.machineId }, input } });
                    expect(failed.statusCode, failed.body).toBe(500);
                    expect(ExternalActionHttpErrorSchema.parse(failed.json())).toEqual({ error: 'invalid_request', code, requestId: id });
                    const diagnostics = records.filter(record => record && typeof record === 'object'
                        && 'module' in record && record.module === 'external-action-error');
                    expect(diagnostics).toEqual([expect.objectContaining({ actionId: 'machines.managed.acquire', requestId: id,
                        phase: 'managed_admission', errorClass: 'TypeError', errorCode: 'EIO',
                        stackFrames: [{ file: '/srv/happier/admission.ts', line: 42, column: 9 }] })]);
                    expect(JSON.stringify(diagnostics)).not.toContain('private');
                    expect(reachedController).toBe(false);
                    expect(Boolean(await db.managedMachine.findFirst({ where: { homeId, admittedActionRequestId: id } })))
                        .toBe(id === requestId);
                } finally { read.mockRestore(); sink.mockRestore(); }
            }
            // Prisma 6.19.2 suppresses rollback errors after a COMMIT error.
            // Exercise its real callback/engine path with lost acknowledgements
            // at the DB boundary: an absent row cannot establish settlement.
            const ambiguousId = 'qb97-ambiguous-completion';
            // Prisma's private engine is an untyped external database boundary.
            const engine = Reflect.get(db, '_engine') as {
                transaction(action: string, headers: unknown, info: unknown): Promise<unknown>;
            };
            const transaction = engine.transaction.bind(engine);
            let admissionRead = false;
            let commitFailed = false;
            let rollbackAcknowledgementLost = false;
            const read = vi.spyOn(db.managedMachine, 'findUnique').mockImplementation(args => {
                if (args.where.homeId_admittedActionRequestId?.admittedActionRequestId === ambiguousId) admissionRead = true;
                return findUnique(args);
            });
            const commit = vi.spyOn(engine, 'transaction').mockImplementation(async (action, headers, info) => {
                if (action === 'commit' && admissionRead && !commitFailed) {
                    commitFailed = true;
                    throw Object.assign(new Error('private commit acknowledgement'), { code: 'EIO' });
                }
                const result = await transaction(action, headers, info);
                if (action === 'rollback' && commitFailed) {
                    rollbackAcknowledgementLost = true;
                    throw new Error('private rollback acknowledgement');
                }
                return result;
            });
            try {
                reachedController = false;
                const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                    headers: { authorization: `Bearer ${token}` },
                    payload: { v: 1, requestId: ambiguousId, target: { kind: 'machine', machineId: controller.machineId }, input } });
                expect(commitFailed).toBe(true);
                expect(rollbackAcknowledgementLost).toBe(true);
                expect(response.statusCode, response.body).toBe(500);
                expect(ExternalActionHttpErrorSchema.parse(response.json())).toEqual({ error: 'invalid_request',
                    code: 'action_outcome_unknown', requestId: ambiguousId });
                expect(reachedController).toBe(false);
                expect(await db.managedMachine.findFirst({ where: { homeId, admittedActionRequestId: ambiguousId } })).toBeNull();
            } finally { commit.mockRestore(); read.mockRestore(); }
        } finally { await instance.close(); }
    });
});
