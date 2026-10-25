import * as React from 'react';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema, type MachineAgentInventoryItem } from '@happier-dev/protocol';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { buildMachineAgentInventoryDescriptors, projectAcpCatalogForMachineInventory } from '@happier-dev/protocol/capabilities';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { createDeferred, createMachineFixture, createPlainMachineRowFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionSystemRecordHttpFixture } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { SessionExecutionRunStartResult } from '@/sync/ops/sessionExecutionRuns';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit, type FileViewRpcRequest } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { StartReviewDialog } = await import('./StartReviewDialog');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let machineSequence = 0;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

const isStart = (request: FileViewRpcRequest) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
    || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1;

// Daemon ACKs are the boundary. Exercise the real Machine Agent projection and readiness owner.
const agentProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
    agentsById: { claude: { id: 'claude', title: 'Claude', capabilities: {
        surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    } } }, actionsById: {}, familiesById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [] });
function reviewerFixture(kind: 'configured' | 'external') {
    const agentId = 'acme.review/reviewer';
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: kind === 'configured' ? [{
        id: 'configured-reviewer', name: 'reviewer', title: 'Configured reviewer',
        launch: { kind: 'npm', package: 'reviewer', version: '1.0', args: [] }, createdAt: 1, updatedAt: 1,
    }] : [] });
    const definitions = projectAcpCatalogForMachineInventory({ status: 'ready', revision: 1, record }).definitions;
    const projection = PluginProjectionV2Schema.parse({ ...agentProjection, agentsById: kind === 'configured' ? {} : {
        [agentId]: { ...agentProjection.agentsById.claude, id: agentId, title: 'External reviewer' },
    } });
    const descriptor = buildMachineAgentInventoryDescriptors(projection, definitions)[0]!;
    const engineId = kind === 'configured' ? buildBackendTargetKeyV2({ kind: 'agent',
        identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: record.definitions[0]!.id }) : agentId;
    return { record, projection, descriptor, engineId };
}

function readinessResponse(request: FileViewRpcRequest, signedIn = true,
    reviewer?: ReturnType<typeof reviewerFixture>, missingReadiness = false): unknown {
    if (request.method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection: reviewer?.projection ?? agentProjection };
    if (request.method !== 'capabilities.detect') return undefined;
    const agent: MachineAgentInventoryItem = { ...(reviewer?.descriptor ?? { agentId: 'claude', title: 'Claude' }), installed: true, version: '1', latestVersion: null,
        update: { supported: false, command: null }, signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'status_only' },
        platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
        ...(reviewer?.descriptor.definitionId ? { managed: true, fit: { kind: 'can_run', via: 'npm' } } : {}) };
    return { protocolVersion: 1, results: {
        ...(missingReadiness ? {} : reviewer?.descriptor.definitionId
            ? { 'tool.acpAgentInventory': { ok: true, checkedAt: Date.now(), data: { items: [agent] } } }
            : { [`cli.${agent.agentId}`]: { ok: true, checkedAt: Date.now(), data: { ...agent, isLoggedIn: signedIn,
                authStatus: { state: signedIn ? 'logged_in' : 'logged_out', checkedAt: Date.now() } } } }),
        'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { protocolVersion: 2,
            backends: { [reviewer?.engineId ?? 'claude']: { available: true, intents: ['review'], supportsVendorResume: true } },
            features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true, secretReferenceOverlay: true } } },
    } };
}

// HTTP is the external boundary: keep Account capture, binding and private requester sealing real.
function reviewInventoryResponse(url: Parameters<RuntimeFetch>[0], init: Parameters<RuntimeFetch>[1], foreign = false,
    reviewer?: ReturnType<typeof reviewerFixture>): Response | null {
    const path = new URL(String(url)).pathname;
    if (!path.startsWith('/v1/actions/review.engines.list')) return null;
    const body: unknown = JSON.parse(String(init?.body));
    const nested = body && typeof body === 'object' && 'envelope' in body ? body.envelope : body;
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(nested);
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('review.engines.list')) {
        return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-read-authorization', binding: {
            accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_review_lifetime',
            machineId: 'm1', installationId: 'foreign-installation', custodianAccountId: 'machine-owner', accountEncryptionMode: 'plain',
            actionId: 'review.engines.list', requestId: envelope.requestId, target: envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } }));
    }
    if (foreign) expect(body).toHaveProperty('executionAuthorization.requesterAccountContext');
    return Response.json({ v: 1, actionId: 'review.engines.list', requestId: envelope.requestId,
        execution: { ok: true, result: { sessionId: null, items: [{ engineId: reviewer?.engineId ?? 'claude', value: reviewer?.engineId ?? 'claude', label: reviewer?.descriptor.title ?? 'Claude',
            enabled: true, backendId: reviewer?.engineId ?? 'claude', capabilities: { structuredNarration: true } }] } } });
}

async function setup(options: Readonly<{ signedIn?: boolean; start?: boolean; reviewer?: 'configured' | 'external'; missingReadiness?: boolean }> = {}) {
    const reviewer = options.reviewer ? reviewerFixture(options.reviewer) : undefined;
    // Capability facts are retained per Machine. Give independent network scenarios independent Machines.
    const machineId = `review-machine-${++machineSequence}`;
    const admission = createDeferred<SessionExecutionRunStartResult>();
    const sessionHttp = createSessionSystemRecordHttpFixture({ sessionId: 's1', records: [] });
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', machineId,
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_review_lifetime',
        machine: createMachineFixture({ id: machineId, kind: 'persistent', storageMode: 'plain', revokedAt: null, replacedByMachineId: null,
            installationId: 'test-installation', access: createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }).access }), rpc: request => {
        if (isStart(request)) return admission.promise;
        return readinessResponse(request, options.signedIn ?? true, reviewer, options.missingReadiness);
    }, request: async (url, init) => reviewInventoryResponse(url, init, false, reviewer) ?? (new URL(String(url)).pathname === ACP_CATALOG_ROWS_ROUTE_V1
        ? Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: reviewer?.record ?? { v: 1, definitions: [] } } }))
        : sessionHttp.request(url, init)),
    });
    const onStarted = vi.fn();
    const onClose = vi.fn();
    const screen = await fixture.render(<StartReviewDialog sessionId="s1" serverId={fixture.home.id} cwd="/repo"
        comparison={{ kind: 'workingTree' }} comparisonId="comparison-1" scopeLabel="Pending changes"
        defaultWalkthrough={false} onClose={onClose} onStarted={onStarted} />);
    if (options.start === false) return { screen, admission, onStarted, onClose, engineId: reviewer?.engineId ?? 'claude' };
    await vi.waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('start-review-start');
    await vi.waitFor(() => expect({
        starts: fixture.requests.filter(isStart),
        error: screen.findByTestId('start-review-error')?.children,
    }).toMatchObject({ starts: [expect.anything()], error: undefined }));
    return { screen, admission, onStarted, onClose, engineId: reviewer?.engineId ?? 'claude' };
}

describe('Review start mounted lifetime', () => {
    it.each(['configured', 'external'] as const)('selects a ready %s reviewer using its real inventory and target identities', async reviewer => {
        const { screen, engineId, admission, onStarted } = await setup({ reviewer, start: false });
        await vi.waitFor(() => expect(screen.findByTestId(`start-review-engine-${engineId}`)?.props)
            .toMatchObject({ disabled: false, accessibilityState: { checked: true } }));
        await vi.waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('start-review-start');
        await vi.waitFor(() => expect(fixture.requests.filter(isStart)).toHaveLength(1));
        await act(async () => admission.resolve({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' }));
        await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ reviewRunIds: ['review-run'] }), false));
    });
    it('keeps a configured reviewer unavailable when its Machine readiness is missing', async () => {
        const { screen, engineId } = await setup({ reviewer: 'configured', missingReadiness: true, start: false });
        await vi.waitFor(() => expect(fixture.requests.some(request => request.method === 'capabilities.detect')).toBe(true));
        await flushHookEffects();
        await vi.waitFor(() => expect(screen.findByTestId(`start-review-engine-${engineId}`)?.props)
            .toMatchObject({ disabled: true, accessibilityState: { checked: false } }));
        expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(true);
        expect(fixture.requests.filter(isStart)).toHaveLength(0);
    });
    it('does not preselect or admit an engine whose canonical Machine readiness requires sign-in', async () => {
        const { screen } = await setup({ signedIn: false, start: false });
        await vi.waitFor(() => expect(screen.findByTestId('start-review-engine-claude')?.props.accessibilityLabel)
            .toContain('Needs sign-in'));
        expect(screen.findByTestId('start-review-engine-claude')?.props).toMatchObject({ disabled: true, accessibilityState: { checked: false } });
        expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(true);
        expect(fixture.requests.filter(isStart)).toHaveLength(0);
    });
    it('shows runner restart guidance for a returned typed Run admission refusal', async () => {
        const { screen, admission, onStarted, onClose } = await setup();
        const code = 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING';
        await act(async () => admission.resolve({ ok: false, error: code, errorCode: code }));
        const { t } = await import('@/text');
        await vi.waitFor(() => expect(screen.findByTestId('start-review-error')?.children)
            .toEqual([t('session.staleRunner.banner.body')]));
        expect(onStarted).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it.each(['dismiss', 'unmount'] as const)('cancels foreign Session resume HTTP on %s before Run admission without replay', async departure => {
        const response = createDeferred<Response>();
        let resumeSignal: AbortSignal | null | undefined;
        let resumeRequests = 0;
        const foreignMachine = createMachineFixture({ id: 'm1', kind: 'persistent', storageMode: 'plain', revokedAt: null, replacedByMachineId: null,
            installationId: 'foreign-installation', installationPublicKey: Buffer.from(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5)).publicKey).toString('base64'),
            access: createPlainMachineRowFixture({ id: 'm1', accountId: 'machine-owner' }).access,
        });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', machine: foreignMachine,
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_review_lifetime',
            rpc: request => readinessResponse(request),
            request: async (url, init) => {
                const inventory = reviewInventoryResponse(url, init, true);
                if (inventory) return inventory;
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
                }));
                if (path === bindExternalActionExecutionAuthorizationHttpPathV1('session.open')) {
                    resumeRequests += 1;
                    resumeSignal = init?.signal;
                    return await waitForNetworkResponseForTests(response.promise, init?.signal);
                }
                return Response.json({}, { status: 404 });
            },
        });
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false,
            metadata: { ...fixture.session.metadata!, flavor: 'claude', claudeSessionId: 'native-resume' } }]);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { readOriginalAccountActionMachine } = await import('@/sync/api/externalActionAccountTransport');
        const account = await captureLazyActionAccountContext(fixture.home.id);
        try {
            expect({ identity: account.serverIdentityId, authority: account.credentialAuthorityKind,
                machine: await readOriginalAccountActionMachine(account, 'm1') }).toMatchObject({
                identity: 'srv_review_lifetime', authority: 'account', machine: { kind: 'persistent', revokedAt: null,
                    replacedByMachineId: null, installationId: 'foreign-installation', installationPublicKey: expect.any(Uint8Array),
                    access: { custodian: { accountId: 'machine-owner' }, accessState: 'ready' } },
            });
        } finally { account.dispose(); }
        const onStarted = vi.fn();
        const screen = await fixture.render(<StartReviewDialog sessionId="s1" serverId={fixture.home.id} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="comparison-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={vi.fn()} onStarted={onStarted} />);
        await vi.waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('start-review-start');
        await vi.waitFor(() => expect({ requests: resumeRequests, error: screen.findByTestId('start-review-error')?.children })
            .toEqual({ requests: 1, error: undefined }));
        if (departure === 'dismiss') await screen.pressByTestIdAsync('start-review-cancel');
        else await act(async () => screen.unmount());
        await vi.waitFor(() => expect(resumeSignal?.aborted).toBe(true));
        await act(async () => response.resolve(Response.json({ error: 'late-refusal' }, { status: 403 })));
        await flushHookEffects();
        expect(onStarted).not.toHaveBeenCalled();
        expect(resumeRequests).toBe(1);
        expect(fixture.requests.filter(isStart)).toHaveLength(0);
    });

    it.each(['dismiss', 'unmount'] as const)('cancels the pending admission on %s and ignores its late ACK without replay', async departure => {
        const { screen, admission, onStarted, onClose } = await setup();
        expect(screen.findByTestId('start-review-start')?.props.accessibilityState?.busy).toBe(true);
        if (departure === 'dismiss') await screen.pressByTestIdAsync('start-review-cancel');
        else await act(async () => screen.unmount());
        await vi.waitFor(() => expect(fixture.emissions.filter(item => item.event === SOCKET_RPC_EVENTS.CANCEL)).toHaveLength(1));
        await act(async () => admission.resolve({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' }));
        await flushHookEffects();
        expect(onStarted).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(departure === 'dismiss' ? 1 : 0);
        expect(fixture.requests.filter(isStart)).toHaveLength(1);
    });

    it('accepts delayed valid admission once while the dialog remains mounted', async () => {
        const { screen, admission, onStarted, onClose } = await setup();
        await flushHookEffects();
        expect(screen.findByTestId('start-review-start')?.props.accessibilityState?.busy).toBe(true);
        expect(onStarted).not.toHaveBeenCalled();
        await act(async () => admission.resolve({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' }));
        await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ reviewRunIds: ['review-run'] }), false));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(fixture.requests.filter(isStart)).toHaveLength(1);
        expect(fixture.emissions.filter(item => item.event === SOCKET_RPC_EVENTS.CANCEL)).toHaveLength(0);
    });
});
