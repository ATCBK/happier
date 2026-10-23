import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { PROVIDER_BROKER_ROUTE_AUDIENCE_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { signProviderBrokerRouteGrantV1, verifyProviderBrokerRouteGrantSignatureV1 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { authorizeTeamCredentialProviderModelCatalog } from './providerBrokerAdmission';
import { writeSessionTeamCredentialBindingsInTx } from './sessionBinding';
import { resolveTeamCredentialBrokerPlacementFingerprint } from './brokerPlacementResolver';
import { openAccountConnectionProviderBroker, admitAccountConnectionProviderBroker } from '@/app/providers/providerBrokerAdmission';
import { verifyProviderBrokerRouteGrantSignatureV2 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Granted broker initiator (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    it('authorizes the foreign endpoint through current Use admission, then refuses its retained grant after revocation', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Granted broker ${randomUUID()}` } });
        try {
            const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: requester.id, role: 'member' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
            const worker = await db.machine.create({ data: {
                id: randomUUID(), accountId: custodian.id, installationId: randomUUID(), active: true,
                metadata: encodePlainMachineStoredContent({ host: 'worker', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
                operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: '1'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const broker = await db.machine.create({ data: {
                id: randomUUID(), accountId: custodian.id, metadata: '{}', active: true,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: '2'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            await expect(inTx(tx => setMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: worker.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view',
            }))).resolves.toMatchObject({ kind: 'saved', readiness: 'ready' });
            const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: '{}', active: true } });
            await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                accountId: requester.id, machineId: worker.id, sessionId: session.id, data: '{}',
            }))).resolves.toMatchObject({ ok: true, created: true });
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: custodian.id, displayName: 'Granted broker', enabled: true,
                disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', brokerMachineId: broker.id,
                sourceBindingJson: JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'pg-connection',
                    connectionSecurityFingerprint: 'connection-security:v1:pg-connection', credentialSlotId: 'apiKey' }),
                memberGrants: { create: { teamMembershipId: member.id, deliveryMode: 'brokered' } },
            } });
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                accountId: requester.id, sessionId: session.id,
                intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
                    expectedResourceRevision: resource.revision, deliveryMode: 'brokered', teamId: team.id }],
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [], tokenEpoch: requester.tokenEpoch },
            }))).resolves.toEqual({ ok: true });
            const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
            const authority = signProviderBrokerRouteGrantV1({ signingKey: { keyId: 'pg-home', secretKey: signing.secretKey }, payload: {
                v: 1, grantId: randomUUID(), aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V1, issuedAt: 1, expiresAt: 10_000,
                teamId: team.id, resourceId: resource.id, sourceRevision: 'source-revision-1',
                brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource), initiatorTokenEpoch: requester.tokenEpoch,
                initiator: { accountId: requester.id, machineId: worker.id, endpointId: '1'.repeat(64) },
                target: { custodianAccountId: custodian.id, machineId: broker.id, endpointId: '2'.repeat(64) },
                consumer: { kind: 'session', sessionId: session.id },
                application: { agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'openai-responses', protocol: 'openai-responses' },
            } });
            const read = () => authorizeTeamCredentialProviderModelCatalog({
                authenticatedBrokerAccountId: custodian.id, authority, expectedResourceRevision: resource.revision,
                readCurrentBrokerPresence: async () => ({ state: 'partial', machineIds: new Set([broker.id]) }),
                verifyAuthority: candidate => verifyProviderBrokerRouteGrantSignatureV1({ authority: candidate, nowMs: 1,
                    signingCapability: { keyId: 'pg-home', publicKey: Buffer.from(signing.publicKey).toString('base64url'), expiresAt: null } }),
            });
            expect(await read()).toEqual({ ok: true });
            const hub = await db.machine.create({ data: {
                id: randomUUID(), accountId: requester.id, metadata: '{}', active: true,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1, 2] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: '3'.repeat(64) } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const verifyAuthority = (candidate: unknown) => verifyProviderBrokerRouteGrantSignatureV2({ authority: candidate, nowMs: 1,
                signingCapability: { keyId: 'pg-home', publicKey: Buffer.from(signing.publicKey).toString('base64url'), expiresAt: null } });
            let presenceReads = 0;
            const common = { homeId: 'pg-home', actorAccountId: requester.id,
                readCurrentPresence: async () => {
                    presenceReads += 1;
                    return { initiatorPresence: { state: 'partial' as const, machineIds: new Set([worker.id]) },
                        targetPresence: { state: 'partial' as const, machineIds: new Set([hub.id]) } };
                },
                resolveExecutionRunCurrentness: async () => ({ ok: true as const, parentSessionId: null, occurrenceId: 'pg-run-occurrence' }) };
            const personalAuthorities = [];
            const originalTransaction = db.$transaction;
            let successfulAdmissions = 0;
            let fencedFinalAdmissions = 0;
            // Observe the real callback/commit boundary. The contender probes
            // the same Account publication lock required to complete withdrawal;
            // NOWAIT is test-only evidence, not a production timeout or retry.
            db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
                const callback: unknown = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                const observed = new Proxy(callback, { async apply(fn, context, callbackArgs) {
                    const result: unknown = await Reflect.apply(fn, context, callbackArgs);
                    if (result && typeof result === 'object' && 'result' in result) {
                        const admission = result.result;
                        if (admission && typeof admission === 'object' && 'ok' in admission && admission.ok === true
                            && ++successfulAdmissions % 2 === 0) {
                            await expect(db.$queryRawUnsafe(
                                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', requester.id,
                            )).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
                            fencedFinalAdmissions += 1;
                        }
                    }
                    return result;
                } });
                return Reflect.apply(target, receiver, [observed, ...args.slice(1)]);
            } });
            try {
                for (const consumer of [{ kind: 'session', sessionId: session.id },
                    { kind: 'execution_run', executionRunId: 'pg-run' }] as const) {
                    const openInput = { ...common, tokenEpoch: requester.tokenEpoch,
                        nowMs: 1, grantId: randomUUID(), signingKey: { keyId: 'pg-home', secretKey: signing.secretKey },
                        verifyRefreshAuthority: verifyAuthority,
                        request: { v: 2 as const, initiatorMachineId: worker.id, targetMachineId: hub.id, consumer,
                            application: authority.payload.application,
                            source: { kind: 'account_connection' as const, connectionId: ProviderConnectionIdSchema.parse('pg-personal'),
                                expectedConnectionSecurityFingerprint: 'connection-security:v1:pg-personal',
                                expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:pg-personal' } } };
                    const opened = await openAccountConnectionProviderBroker(openInput);
                    expect(opened).toMatchObject({ ok: true, authority: { payload: {
                        initiator: { accountId: requester.id, machineId: worker.id }, target: { custodianAccountId: requester.id, machineId: hub.id },
                    } } });
                    if (!opened.ok) throw new Error(opened.reasonCode);
                    expect(verifyAuthority(opened.authority)).toBe(true);
                    expect(await admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
                        request: { v: 2, authority: opened.authority } })).toEqual({ ok: true });
                    expect(await openAccountConnectionProviderBroker({ ...openInput,
                        request: { ...openInput.request, refreshAuthority: opened.authority } })).toMatchObject({ ok: true });
                    personalAuthorities.push(opened.authority);
                }
                expect(fencedFinalAdmissions).toBe(6);
            } finally {
                db.$transaction = originalTransaction;
            }
            await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: worker.id,
                principal: { kind: 'account', accountId: requester.id },
            }));
            expect(await read()).toEqual({ ok: false, reasonCode: 'operation_not_current' });
            const readsBeforeRevocation = presenceReads;
            for (const personalAuthority of personalAuthorities) {
                expect(await admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
                    request: { v: 2, authority: personalAuthority } })).toMatchObject({ ok: false });
            }
            expect(presenceReads).toBe(readsBeforeRevocation);
        } finally {
            await db.team.delete({ where: { id: team.id } });
            await db.accessKey.deleteMany({ where: { accountId: requester.id } });
            await db.session.deleteMany({ where: { accountId: requester.id } });
            await db.machine.deleteMany({ where: { accountId: { in: [requester.id, custodian.id] } } });
            await db.account.deleteMany({ where: { id: { in: [requester.id, custodian.id] } } });
        }
    });
});
