import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from './serverHttpBaseUrl';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { createAccountPetViaActiveServer } from '@/pets/storage/createAccountPetClient';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';

describe('default Account HTTP endpoints', () => {
  afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

  it.each(['worker', 'pet', 'binding'] as const)('sends %s requests through the publication, retaining invocation and explicit endpoints', async kind => {
    const home = await mkdtemp(join(tmpdir(), 'happier-http-default-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:1');
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'published-home');
    reloadConfiguration();
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/v3/automations/worker/assignments')
        ? { assignments: [], settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } }
        : request.url?.startsWith('/v3/automations/worker/run-lifecycle') ? { sources: [] }
          : request.url?.includes('/access-keys/') ? { accessKey: 'test-bound-key' }
          : { ok: false, errorCode: 'custom_pet_sync_requires_plaintext', error: 'custom_pet_sync_requires_plaintext' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const release = publishServerHttpRuntimeOrigin(origin, 'iroh');
    try {
      expect(configuration.apiServerUrl).toBe('http://127.0.0.1:1');
      if (kind === 'worker') {
        const client = createAutomationClaimClient({ token: 'test-token' });
        await expect(client.fetchAssignments('machine-test')).resolves.toMatchObject({ assignments: [], runLifecycleSources: [] });
        return;
      }
      if (kind === 'binding') {
        const input = { token: 'test-token', sessionId: 'session-default', machineId: 'machine-test' };
        await ensureSessionMachineAccessKeyBinding(input);
        await ensureSessionMachineAccessKeyBinding({ ...input, serverUrl: `${origin}/explicit` });
        expect(paths).toEqual(['/v1/access-keys/session-default/machine-test',
          '/explicit/v1/access-keys/session-default/machine-test']);
        return;
      }
      const input = { manifest: { id: 'blink', displayName: 'Blink', description: 'Companion', spritesheetPath: 'spritesheet.png' },
        spritesheet: { mediaType: 'image/png' as const, encoding: 'base64' as const, data: 'iVBORw0KGgo=', sizeBytes: 8, digest: 'sha256:asset' },
        origin: { kind: 'manualImport' as const } };
      await expect(createAccountPetViaActiveServer(input, { readCredentials: async () => ({ token: 'test-token' }) }))
        .resolves.toMatchObject({ errorCode: 'custom_pet_sync_requires_plaintext' });
      await runWithServerHttpBaseUrl(`${origin}/invocation`, () => createAccountPetViaActiveServer(input,
        { readCredentials: async () => ({ token: 'test-token' }) }));
      await createAccountPetViaActiveServer(input, { serverUrl: `${origin}/explicit`,
        readCredentials: async () => ({ token: 'test-token' }) });
      expect(paths).toContain('/v1/account/pets');
      expect(paths).toContain('/invocation/v1/account/pets');
      expect(paths).toContain('/explicit/v1/account/pets');
    } finally {
      release(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});
