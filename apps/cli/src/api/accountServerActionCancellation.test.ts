import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';

import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createSpawnConnectedServicesTeamResourceCatalogResolver } from '@/session/services/spawnConnectedServicesDefaults';
import { verifyRequesterSessionMachineAdmissionCurrent } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createDaemonTeamCredentialDirectMaterialReconciler } from '@/daemon/connectedServices/directMaterial/daemonTeamCredentialDirectMaterialReconciler';

afterEach(() => vi.restoreAllMocks());

// A real HTTP peer consumes the request but never sends an acknowledgement.
// The watchdog is test cleanup/failure detection, never a product deadline.
async function withStalledHome(work: (home: Readonly<{
  url: string;
  accepted: Promise<void>;
}>) => Promise<void>) {
  let accept!: () => void;
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (request.url === '/v1/account/profile') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(AccountProfileResponseSchema.parse({ id: 'account' })));
      return;
    }
    request.resume();
    request.on('end', accept);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  try { await work({ url: `http://127.0.0.1:${address.port}`, accepted }); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function expectCancellation<T>(pending: Promise<T>, accepted: Promise<void>, controller: AbortController) {
  await accepted;
  controller.abort();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Containing-operation cancellation did not settle HTTP')), 500);
    })]);
  } finally { clearTimeout(watchdog); }
}

it('cancels a stalled Team catalog through its containing spawn operation', async () => {
  await withStalledHome(async home => {
    const controller = new AbortController();
    const homeDomainAction = createAccountServerActionDeps({ token: 'test-token', serverId: 'home', serverHttpBaseUrl: home.url }).homeDomainAction!;
    const resolve = createSpawnConnectedServicesTeamResourceCatalogResolver({ homeDomainAction, serverId: 'home', accountId: 'account' });
    const input = { teamIds: ['team'], signal: controller.signal };
    const pending = resolve(input);
    expect(await expectCancellation(pending, home.accepted, controller)).toBeNull();
  });
});

it('cancels a stalled machine-access read when its containing requester lifetime retires', async () => {
  await withStalledHome(async home => {
    const controller = new AbortController();
    const input = {
      credentials: { token: 'test-token', encryption: null },
      sessionId: 'session',
      attribution: { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation' },
      serverHttpBaseUrl: home.url,
      boundary: { machineId: 'machine', daemonToken: 'daemon', signal: controller.signal,
        isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'installation', privateKey: new Uint8Array(64) }) },
    } as const;
    const pending = verifyRequesterSessionMachineAdmissionCurrent(input);
    expect(await expectCancellation(pending, home.accepted, controller)).toBe(false);
  });
});

it('cancels a background Team reconciliation when its containing daemon lifetime retires', async () => {
  await withStalledHome(async home => {
    const controller = new AbortController();
    const homeDomainAction = createAccountServerActionDeps({ token: 'test-token', serverId: 'home', serverHttpBaseUrl: home.url }).homeDomainAction!;
    const unused = async (): Promise<never> => { throw new Error('No material may open before the Team list arrives'); };
    const input = { token: 'test-token', accountId: 'account', homeDomainAction, signal: controller.signal,
      establishedRuntimeOwner: { readMaterialSnapshot: unused }, listAccounts: unused, readGroup: unused, resolveProviderSource: unused };
    const reconciler = createDaemonTeamCredentialDirectMaterialReconciler(input);
    expect(await expectCancellation(reconciler.reconcile(), home.accepted, controller))
      .toEqual({ prepared: 0, remaining: 0, failures: [] });
  });
});
