import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { prepareSessionOrganizationDisplayEnvelope } from '@/sync/ops/sessionOrganization/sessionOrganizationDisplayEnvelope';
import { createArtifactWithHeaderViaApi } from '@/sync/engine/artifacts/syncArtifacts';
import { createReviewCommentsHttpActionExecutor } from '@/sync/domains/reviews/comments/api';
import { sealAutomationRecipePayloadForAuthoring } from './automationRecipeAuthoring';
import { encodeAutomationTemplateCiphertextForAccount } from './encodeAutomationTemplateCiphertextForAccount';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// The real process singleton forwards ambient identity demand to the admitted
// Account socket. Loading it during collection keeps cold graph setup out of a hook.
await loadSyncSingletonForTests();
afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
});

it.each(['recipe', 'template', 'organization', 'artifact', 'review-comment'] as const)(
    'refuses to emit plain %s content after authority becomes E2EE while its socket identity remains plain', async kind => {
        const accountId = `sealing-authority-${kind}`;
        const serverUrl = `https://sealing-authority-${kind}.test`;
        const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
        const serverId = await home.addHome({ name: 'Sealing authority', serverUrl, accountId, credentials,
            accountEncryptionMode: 'plain', currentAccount: true });
        let socket: Socket | undefined;
        installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
        let mode: 'plain' | 'e2ee' = 'plain';
        let authorityReads = 0;
        const emittedBodies: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
                authorityReads++;
                return Response.json(path.endsWith('/currentness') ? createPlainAccountEncryptionCurrentnessFixture()
                    : { mode, updatedAt: mode === 'plain' ? 1 : 2 });
            }
            if ((path === '/v1/artifacts' || path.startsWith('/v1/reviews/comments')) && init?.method !== 'GET') {
                emittedBodies.push(String(init?.body));
                return Response.json({ error: 'content_mode_mismatch' }, { status: 400 });
            }
            return home.request(rawUrl, init);
        });
        const lifetime = new AbortController();
        const captured = await captureLazyActionAccountContext(serverId, lifetime.signal);
        try {
            const admitted = captured.credentials;
            apiSocket.initialize({ endpoint: serverUrl, token: admitted.token, credentials: admitted, serverId,
                generation: getActiveServerSnapshot().generation,
                request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: admitted }),
                isCurrent: captured.accountLifetime.isCurrent }, null);
            await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
            expect(apiSocket.getAccountEncryptionObservationBinding(admitted)).not.toBeNull();
            await expect(fetchAccountEncryptionMode(admitted)).resolves.toMatchObject({ mode: 'plain' });
            const warmedReads = authorityReads;
            await expect(fetchAccountEncryptionMode(admitted)).resolves.toMatchObject({ mode: 'plain' });
            expect(authorityReads).toBe(warmedReads);
            // Only HTTP authority changes. No push or disconnect is delivered.
            mode = 'e2ee';
            const seal = kind === 'recipe'
                ? sealAutomationRecipePayloadForAuthoring({ credentials: admitted, payload: { private: 'recipe' } })
                : kind === 'template'
                    ? encodeAutomationTemplateCiphertextForAccount({ credentials: admitted,
                        template: { directory: '/private', prompt: 'Private template' } })
                    : kind === 'organization'
                        ? prepareSessionOrganizationDisplayEnvelope({ credentials: admitted, value: { label: 'Private label' } })
                        : kind === 'artifact'
                            ? createArtifactWithHeaderViaApi({ credentials: admitted, encryption: null,
                                artifactDataKeys: new Map(), header: { title: 'Private Artifact' }, body: 'Private body', addArtifact: () => {} })
                            : createReviewCommentsHttpActionExecutor()('reviews.comments.create', {
                                projectId: 'project', anchor: { kind: 'file', filePath: 'private.ts' },
                                snapshot: { kind: 'too_large', filePath: 'private.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                                body: 'Private review', clientMutationId: 'private-mutation',
                            });
            await expect(seal).rejects.toBeInstanceOf(Error);
            expect(authorityReads).toBe(warmedReads + 1);
            expect(emittedBodies).toEqual([]);
            expect(socket?.connected).toBe(true);
        } finally { lifetime.abort(); captured.dispose(); }
    },
);
