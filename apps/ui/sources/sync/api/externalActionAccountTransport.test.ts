import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';

// Only authenticated HTTP and device credential IO leave this process.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { executeOriginalAccountActionTransport } = await import('./externalActionAccountTransport');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;
const path = '/v1/actions/plugins.uninstall';
const binding: ExternalActionEncryptionBindingV2 = {
    serverIdentityId: 'srv_plugin_transport', accountId: 'owner',
    authentication: { kind: 'account', tokenEpoch: 0 },
    actionId: 'plugins.uninstall', requestId: 'uninstall-1', target: { kind: 'machine', machineId: 'machine-1' },
};

beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Plugin transport', serverUrl: 'https://plugin-transport.test',
        serverIdentityId: binding.serverIdentityId, accountId: 'owner', currentAccount: true, active: false });
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; vi.useRealTimers(); await homes.reset(); });

async function execute() {
    if (!account) throw new Error('Expected captured Account');
    const result = await executeOriginalAccountActionTransport({ account, binding,
        input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user' });
    expect(homes.requestsFor(path)).toHaveLength(1);
    expect(ActionExecuteFailureSchema.safeParse(result).success).toBe(true);
    return result;
}

describe('captured Account Action response decoding', () => {
    it.each(['action_not_admitted', 'action_outcome_unknown'] as const)('preserves request correlation for %s and refuses a mismatched reply', async code => {
        const refusal = projectExternalActionHttpError(code, binding.requestId);
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: code, details: { requestId: binding.requestId } });
        homes.answer(serverId, path, { status: refusal.statusCode,
            body: projectExternalActionHttpError(code, 'another-request').payload });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountActionTransport({ account, binding, input: {} }))
            .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('projects native optional members before the strict envelope for other app Action families', async () => {
        homes.answer(serverId, path, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.input).toEqual({ machineId: 'machine-1', pluginId: 'example.plugin',
                options: { enabled: false, selection: null } });
            return { body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } };
        } });
        if (!account) throw new Error('Expected captured Account');
        expect(await executeOriginalAccountActionTransport({ account, binding, input: {
            machineId: 'machine-1', pluginId: 'example.plugin', optional: undefined,
            options: { optional: undefined, enabled: false, selection: null },
        } })).toEqual({ ok: true, result: { completed: true } });
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it.each([new Map(), [undefined], { callback: () => true }])('refuses genuinely non-JSON input before HTTP issuance (%j)', async invalid => {
        if (!account) throw new Error('Expected captured Account');
        const onTransportIssued = vi.fn();
        expect(await executeOriginalAccountActionTransport({ account, binding,
            input: { invalid }, onTransportIssued })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(homes.requestsFor(path)).toEqual([]);
        expect(onTransportIssued).not.toHaveBeenCalled();
    });

    it('keeps non-spawn Action lifetime independent from the Session startup budget', async () => {
        let release!: () => void;
        homes.answer(serverId, path, { respondAfter: new Promise<void>(resolve => { release = resolve; }),
            body: { v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { completed: true } } } });
        if (!account) throw new Error('Expected captured Account');
        vi.useFakeTimers();
        let settled = false;
        const pending = executeOriginalAccountActionTransport({ account, binding,
            input: { machineId: 'machine-1', pluginId: 'example.plugin' }, authority: 'present_user' })
            .finally(() => { settled = true; });
        await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(readSpawnSessionRpcTimeoutMsFromEnv() + 1);
        expect(settled).toBe(false);
        release();
        await expect(pending).resolves.toEqual({ ok: true, result: { completed: true } });
    });

    it('keeps the server’s empty post-dispatch 502 acknowledgement loss uncertain', async () => {
        // registerExternalActionRoutes sends exactly this empty response after
        // its daemon dispatcher reports submitted_unknown, without a retry.
        homes.answer(serverId, path, { status: 502 });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    });

    it.each([
        { status: 200 },
        { status: 502, body: { notAnActionResponse: true } },
    ])('does not reinterpret another malformed response as known acknowledgement loss (%j)', async answer => {
        homes.answer(serverId, path, answer);
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('preserves a schema-valid pre-dispatch refusal instead of making it uncertain', async () => {
        const refusal = projectExternalActionHttpError('invalid_envelope', binding.requestId);
        homes.answer(serverId, path, { status: refusal.statusCode, body: refusal.payload });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'invalid_envelope' });
    });
});
