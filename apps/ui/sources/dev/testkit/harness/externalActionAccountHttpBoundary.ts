import sodium from 'libsodium-wrappers';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionResponseEnvelopeV1Schema,
    type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createPlainMachineRowFixture } from '../fixtures/machineFixtures';

/** One current plain Account's external issuer and Machine HTTP responses.
 * Account capture, custody admission, authorization binding and requester-box crypto stay real.
 */
export async function createExternalActionAccountHttpBoundary(params: Readonly<{
    serverUrl: string;
    serverIdentityId: string;
    accountId: string;
    machineId: string;
    actionId: ActionId;
    tokenEpoch: number;
    execute(input: unknown, context: Readonly<{
        target: NonNullable<ExternalActionRequestEnvelopeV1['target']>;
        invocation: ExternalActionRequesterInvocationV1;
    }>): Promise<unknown> | unknown;
}>) {
    await sodium.ready;
    const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(27));
    const machine = {
        ...createPlainMachineRowFixture({ id: params.machineId, accountId: params.accountId }),
        installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
    };
    return {
        async handle(url: URL, init?: RequestInit): Promise<Response | null> {
            if (url.origin !== new URL(params.serverUrl).origin) return null;
            if (url.pathname === '/v1/machines') return Response.json([machine]);
            const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(params.actionId);
            if (url.pathname !== mintPath && url.pathname !== `/v1/actions/${params.actionId}`) return null;
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            if (request.envelope.v !== 1) throw new Error('Expected the plain external Action fixture envelope');
            const target = request.envelope.target;
            if (request.machineId !== machine.id || target?.kind !== 'machine'
                || target.machineId !== machine.id) throw new Error('Unexpected external Action fixture target');
            if (url.pathname === mintPath) {
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: 'test-external-action-authorization', binding: {
                        accountId: params.accountId, authentication: { kind: 'account', tokenEpoch: params.tokenEpoch },
                        serverIdentityId: params.serverIdentityId, machineId: machine.id,
                        custodianAccountId: params.accountId, installationId: machine.installationId,
                        accountEncryptionMode: 'plain', actionId: params.actionId,
                        requestId: request.envelope.requestId, target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                    },
                }));
            }
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId!,
                serverIdentityId: params.serverIdentityId, installationPrivateKey: installation.privateKey, includeInvocation: true });
            if (!opened?.invocation || request.executionAuthorization?.binding.requestEnvelopeDigest
                !== computeExternalActionRequestEnvelopeDigestV1(request.envelope)) throw new Error('Invalid private requester Account carrier');
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
                v: 1, requestId: request.envelope.requestId, actionId: params.actionId,
                execution: { ok: true, result: await params.execute(request.envelope.input, {
                    target, invocation: opened.invocation,
                }) },
            }));
        },
    };
}
