import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { PendingActivationFailureDetailsV1Schema, PendingActivationFailureRequestV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { logger } from '@/ui/logger';
import * as cliProcess from '@/utils/spawnHappyCLI';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the OS listener is replaced; startup, exit supervision and requester custody remain real.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43127, stop: async () => {} };
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it.each(['definite', 'transient', 'replaced', 'wrong-target'] as const)(
  'settles only the exact current pending activation after a post-webhook %s startup exit', async disposition => {
    const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://session-home.test',
      resolveCurrentMachineId: () => 'machine' });
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
      resolveCurrentMachineExecutionOriginContext: resolveOrigin,
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => String(input) === 'https://session-home.test/v1/features'
      ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_requester_home' } } }))
      : originalFetch(input, init)));
    const warnings = vi.spyOn(logger, 'warn');
    const diagnostics = vi.spyOn(logger, 'debug');
    // A retry may prepare normally, but this test never launches a physical child.
    vi.spyOn(cliProcess, 'spawnHappyCLI').mockImplementation(() => { throw new Error('Native launch unavailable in fixture'); });
    const requestId = 'original-pending';
    const requestedAt = 10;
    h.tracked.spawnOptions!.executionAuthorization = { provenance: 'user_request', requestId, requestedAt };
    // This is the same producer used by host construction failure publication.
    const error = new PromptStackPreparationError('unavailable', { kind: 'doc', artifactId: 'private-reference' });
    if (disposition !== 'transient') Object.assign(error, { cause: new HomeTargetResolutionError('profile_missing', 'private-reference') });
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error, occurredAt: 20 });
    const pendingActivationAuthorization = { requestId: disposition === 'replaced' ? 'newer-pending' : requestId,
      requestedAt, status: 'waiting' as const, admittedTarget: { homeId: 'srv_requester_home',
        accountId: 'requester', sessionId: h.sessionId, machineId: 'machine',
        installationId: disposition === 'wrong-target' ? 'replacement-installation' : h.f.installation.installationId } };
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}`) return { status: 200, data: {
        session: createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain', metadata: '{}',
          ownerAccountId: 'requester', origin: { kind: 'none' }, pendingCount: 1,
          pendingActivationAuthorization, latestTurnStatus: 'failed', lastRuntimeIssue: issue }) } };
      return get(url, ...args);
    });
    const reports: unknown[] = [];
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, data, config) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}/pending/activation/fail`) {
        expect(new URL(String(url)).origin).toBe('https://session-home.test');
        expect(config?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
        reports.push({ body: PendingActivationFailureRequestV1Schema.parse(data),
          details: PendingActivationFailureDetailsV1Schema.parse(JSON.parse(String(config?.params?.failureDetails))) });
        return { status: 200, data: { ok: true, didFail: true } };
      }
      return post(url, data, config);
    });
    // The Home Machine terminal transport is unavailable; that does not invent a publisher or block supervision.
    vi.spyOn(h.machine, 'captureMachineSessionTerminal').mockRejectedValue(new Error('Home terminal transport unavailable'));
    await h.daemon.onChildExited(h.tracked.pid, { reason: 'process-exit', code: 1, signal: null });
    if (disposition === 'definite') {
      await expect.poll(() => reports, { timeout: 10_000 }).toEqual([{ body: { requestId, requestedAt,
        failureCode: 'runtime_start_failed' }, details: { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' } }]);
    } else {
      if (disposition === 'transient') {
        await expect.poll(() => diagnostics.mock.calls.some(([message]) => String(message)
          .startsWith(`[DAEMON RUN] Respawning runner for session ${h.sessionId}`)), { timeout: 10_000 }).toBe(true);
      } else {
        await expect.poll(() => warnings.mock.calls.some(([message]) => String(message)
          .includes(`Respawn suppressed for session ${h.sessionId} (startup dependency: profile_missing)`)), { timeout: 10_000 }).toBe(true);
      }
      expect(reports).toEqual([]);
    }
    expect(JSON.stringify(reports)).not.toContain('private-reference');
  },
);
