import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ManagedPolicyCensusInputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';

afterEach(() => vi.restoreAllMocks());
describe('daemon managed policy census transport', () => {
    it('defers unused retention until enrollment without deferring a reviewed deadline or canceled creation cleanup', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
        // The actual operation/adapter path remains real. This installation has
        // no native custody, so any scheduled attempt settles as unavailable.
        const adapter = createDaemonManagedMachineActionAdapter({ credentials: { token: 'owner-token', encryption: null },
            machineId: 'controller', serverId: 'home', serverBaseUrl: 'https://home.example', installationIdentity: null,
            acquireRuntimeRegistryLease: async () => { throw new Error('No native runtime is installed'); },
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved) => executeManagedMachinePolicyAction({ machine: current,
                context, runApproved, serverId: 'home', createExecutor: overrides => createActionExecutor(overrides) }),
        });
        const list = async () => ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items;
        const runtime = createDaemonManagedMachinePolicyRuntime({
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home', controller: machine.controller,
                custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example', signal }),
            executePolicy: adapter.executePolicy,
        });
        const notify = async () => {
            runtime.notifyChanged();
            // Drain the in-process census/operation microtasks, including a
            // possible failure, before reading the real operation RPC surface.
            await new Promise<void>(resolve => setImmediate(resolve));
        };
        try {
            await notify();
            expect(await list()).toEqual([]);
            machine = ManagedMachineV1Schema.parse({ ...machine, enrolledMachineId: 'guest' });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'failed', error: { errorCode: 'admission_unavailable' } }]));
            machine = ManagedMachineV1Schema.parse({ ...machine, enrolledMachineId: undefined,
                retention: { kind: 'deadline', at: Date.now() + 3_600_000, effect: 'stop', interrupts: true } });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(2));
            machine = ManagedMachineV1Schema.parse({ ...machine, creationState: 'canceled', desired: 'delete' });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(3));
            machine = ManagedMachineV1Schema.parse({ ...machine, creationState: 'active', desired: 'stop',
                retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
                submittedNativeEffect: { intentRevision: 0, requestId: 'submitted-stop', intent: 'stop', controller: machine.controller } });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(4));
        } finally {
            await runtime.stop();
        }
    });
    it('does not read policy work while controller prerequisites are absent and resumes when they become available', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const requests: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            requests.push(body);
            return { status: 200, data: { machines: [], targets: [] } };
        });
        let available = false;
        const unavailable: unknown[] = [];
        const options = {
            isAvailable: () => available,
            readCensus: (signal: AbortSignal) => readManagedMachinePolicyCensus({
                homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
                custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example', signal,
            }),
            executePolicy: async () => { throw new Error('No policy was admitted'); },
            onUnavailable: (error: unknown) => unavailable.push(error),
        };
        const runtime = createDaemonManagedMachinePolicyRuntime(options);
        try {
            runtime.notifyChanged();
            await Promise.resolve();
            runtime.notifyChanged();
            await Promise.resolve();
            expect(requests).toEqual([]);
            expect(unavailable).toEqual([]);
            available = true;
            runtime.notifyChanged();
            await vi.waitFor(() => expect(requests).toHaveLength(1));
        } finally {
            await runtime.stop();
        }
    });
    it('reads only the current signed controller census and rejects unavailable authority rather than inventing empty work', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            expect(url).toBe('https://home.example/v1/machines/managed/controller/policies');
            const input = ManagedPolicyCensusInputV1Schema.parse(body);
            expect(verifyMachineInstallationProof({ proof: input.proof, publicKey: key.publicKey,
                payload: { version: 1, machineId: input.controller.machineId,
                    installationId: input.controller.installationId, accountId: 'owner',
                    managedPolicyCensus: { homeId: input.homeId } } })).toBe(true);
            return { status: 200, data: { machines: [], targets: [] } };
        });
        const input = { homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
            custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example' };
        expect(await readManagedMachinePolicyCensus(input)).toEqual({ machines: [], targets: [] });
        vi.mocked(axios.post).mockResolvedValue({ status: 403, data: { machines: [], targets: [] } });
        await expect(readManagedMachinePolicyCensus(input)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });
});
