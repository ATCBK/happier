import { describe, expect, it, vi } from 'vitest';
import { createBoatNativeClient } from './nativeClient.js';

const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers).entries()) },
});

describe('Boat native HTTP boundary', () => {
  it('enumerates truthful choices and offers xlarge only from the current limits entitlement', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'limits.info', sandboxPlanDollars: 20, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }))
      .mockResolvedValueOnce(json({ ok: true, type: 'snapshot.named.list', snapshots: [{ name: 'ready-one', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }, { name: 'busy-one', status: 'saving', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }] }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.list', sandboxes: [{ id: 'bx_23456789', name: 'Source', state: 'ready' }] }));
    const options = await createBoatNativeClient({ fetch }).options();
    expect(options.sizes.map(value => value.id)).toEqual(['small', 'default', 'large']);
    expect(options.snapshots).toEqual([{ name: 'ready-one', status: 'ready' }]);
    expect(options.sandboxes).toEqual([{ id: 'bx_23456789', name: 'Source', state: 'ready' }]);

    fetch.mockReset()
      .mockResolvedValueOnce(json({ ok: true, type: 'limits.info', sandboxPlanDollars: 100, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }))
      .mockResolvedValueOnce(json({ ok: true, type: 'snapshot.named.list', snapshots: [] }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.list', sandboxes: [] }));
    expect((await createBoatNativeClient({ fetch }).options()).sizes.map(value => value.id)).toContain('xlarge');
  });

  it('revalidates a named snapshot and binds the exact host-derived idempotency request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'snapshot.named.list', snapshots: [{ name: 'base-one', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }] }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null, sandbox: { id: 'bx_abcdefgh', state: 'provisioning' } }, 202));
    const result = await createBoatNativeClient({ fetch }).acquire({
      launch: { size: 'large', source: { kind: 'named-snapshot', name: 'base-one' } },
      idempotencyKey: 'managed-1',
    });
    expect(result).toMatchObject({ kind: 'pending', operation: { sandboxId: 'bx_abcdefgh' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, request] = fetch.mock.calls[1];
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('managed-1');
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({ type: 'large', from: 'base-one', snapshots: true, noEnv: true, ttlSeconds: null });
  });

  it('preserves one uncertain request and distinguishes in-progress from body mismatch', async () => {
    const pendingFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('lost reply'));
    const client = createBoatNativeClient({ fetch: pendingFetch });
    const first = await client.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-2' });
    expect(first).toMatchObject({ kind: 'pending', operation: { idempotencyKey: 'managed-2', sourceKind: 'blank' } });

    const inProgress = createBoatNativeClient({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: false, type: 'sandbox.error', status: 409, code: 'idempotency_in_progress', message: 'busy', error: { code: 'idempotency_in_progress', message: 'busy', status: 409 }, requestId: 'req_1' }, 409)) });
    expect(await inProgress.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-2' }))
      .toMatchObject({ kind: 'pending' });
    const mismatch = createBoatNativeClient({ fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: false, type: 'sandbox.error', status: 409, code: 'idempotency_key_reused', message: 'mismatch', error: { code: 'idempotency_key_reused', message: 'mismatch', status: 409 }, requestId: 'req_2' }, 409)) });
    expect(await mismatch.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-2' }))
      .toEqual({ kind: 'refused', code: 'native_idempotency_mismatch' });
  });

  it('maps harness idle/running only to resource availability and validates SSH evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'idle' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshEndpoint: '203.0.113.8:22', sshUser: 'user', hostKey: 'ssh-ed25519 AAAAboat' }));
    const client = createBoatNativeClient({ fetch });
    expect(await client.inspect({ sandboxId: 'bx_23456789' })).toEqual({ kind: 'present', power: 'running' });
    expect(await client.bootstrap({ sandboxId: 'bx_23456789' }, 'ssh-ed25519 AAAApublic')).toEqual({
      address: '203.0.113.8', port: 22, username: 'user', hostKey: 'ssh-ed25519 AAAAboat',
    });
  });

  it('settles deletion only from the retained operation and sends the exact confirmation header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.deleting', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'pending', attemptCount: 0, requestedAt: '2026-10-12T00:00:00Z', completedAt: null } }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'processing', attemptCount: 1, requestedAt: '2026-10-12T00:00:00Z', completedAt: null } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'completed', attemptCount: 1, requestedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z' } }));
    const client = createBoatNativeClient({ fetch });
    const operation = { kind: 'delete' as const, operationId: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sandboxId: 'bx_23456789' };
    expect(await client.destroy({ resource: { sandboxId: 'bx_23456789' } })).toEqual({ kind: 'pending', operation });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('x-ascii-confirm-delete')).toBe('bx_23456789');
    expect(await client.reconcileDestroy(operation)).toEqual({ kind: 'pending' });
    expect(await client.reconcileDestroy(operation)).toEqual({ kind: 'confirmed' });
  });

  it('stops and resumes the same sandbox without a plugin-owned daemon relaunch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.stopping', status: 'archiving', sandbox: { id: 'bx_23456789', state: 'archiving' } }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'archived' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.resuming', status: 'provisioning', sandbox: { id: 'bx_23456789', state: 'provisioning' } }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'ready' } }));
    const client = createBoatNativeClient({ fetch });
    expect(await client.power({ sandboxId: 'bx_23456789' }, 'stop')).toEqual({ kind: 'confirmed' });
    expect(await client.power({ sandboxId: 'bx_23456789' }, 'resume')).toEqual({ kind: 'confirmed' });
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({ ttlSeconds: null });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/sandboxes/bx_23456789/stop', '/api/v1/sandboxes/bx_23456789',
      '/api/v1/sandboxes/bx_23456789/resume', '/api/v1/sandboxes/bx_23456789',
    ]);
  });

  it('surfaces rate and entitlement refusals without an internal retry loop', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: false, type: 'sandbox.error', status: 429, code: 'limit_reached', message: 'limit', error: { code: 'limit_reached', message: 'limit', status: 429 }, requestId: 'req_3' }, 429));
    await expect(createBoatNativeClient({ fetch }).inspect({ sandboxId: 'bx_23456789' })).rejects.toMatchObject({ code: 'native_limit_reached', retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
