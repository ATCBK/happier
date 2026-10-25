import { describe, expect, it } from 'vitest';
import { createVercelNativeClient } from './nativeClient.js';
import { reference, type VercelOperation } from './schemas.js';

const scope = { teamId: 'team_one', projectId: 'prj_one' };
const launch = { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 };
const resource = { ...scope, name: 'happier-managed-1', managedId: 'managed-1', createdAt: 1000 };
const session = { id: 'sbx_one', sourceSandboxName: resource.name, projectId: scope.projectId, createdAt: 1000,
  requestedAt: 1000, updatedAt: 1000, cwd: '/vercel/sandbox', memory: 4096, region: 'iad1', runtime: 'image',
  status: 'running', timeout: 300000, vcpus: 2 };
function named(status = 'running') { return { name: resource.name, createdAt: 1000, updatedAt: 1000, statusUpdatedAt: 1000,
  currentSessionId: session.id, currentSnapshotId: status === 'stopped' ? 'snap_one' : undefined,
  persistent: true, status, tags: { 'happier-managed-id': resource.managedId }, architecture: 'amd64',
  expiresAt: status === 'running' ? 301000 : undefined, snapshotExpiration: 0 }; }
function fixture(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>, signal?: AbortSignal) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => { const parsed = new URL(String(url)); calls.push({ url: parsed, init }); return handler(parsed, init); };
  return { client: createVercelNativeClient(scope, fetcher, signal, 2000), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const snapshot = { id: 'snap_one', sourceSessionId: session.id, status: 'created', createdAt: 2000, lastUsedAt: 2000, sizeBytes: 1000, updatedAt: 2000 };
const emptyPage = { snapshots: [], pagination: { count: 0, next: null } };
describe('Vercel retained REST resource', () => {
  it.each([400, 401, 403, 422])('reports definite REST create refusal %i without inventing uncertain paid custody', async status => {
    const { client } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (init?.method === 'POST') return json({ error: { message: 'private vendor body' } }, status);
      return json({}, 404);
    });
    expect(await client.acquire(launch, resource.managedId)).toEqual({ kind: 'rejected',
      code: status === 401 || status === 403 ? 'credential_unavailable' : 'invalid_request',
      nativeCause: { httpStatusClass: '4xx' } });
  });

  it('reports a native plan lookup refusal without disclosing its response body', async () => {
    const { client, calls } = fixture(() => json({ error: { code: 'private-token', message: 'private vendor body' } }, 403));
    expect(await client.acquire(launch, resource.managedId)).toEqual({ kind: 'rejected', code: 'credential_unavailable',
      nativeCause: { httpStatusClass: '4xx' } });
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false);
  });

  it('does not classify cancellation before native IO as provider unavailability', async () => {
    const controller = new AbortController(); controller.abort();
    const { client, calls } = fixture(() => { throw new Error('no HTTP'); }, controller.signal);
    await expect(client.acquire(launch, resource.managedId)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('retains cost custody when missing native metadata cannot qualify surviving snapshots', async () => {
    const { client, calls } = fixture(url => url.pathname === '/v2/sandboxes/snapshots'
      ? json({ snapshots: [snapshot], pagination: { count: 1, next: null } }) : json({}, 404));
    expect(await client.inspect(resource)).toMatchObject({ availability: 'unavailable', reason: 'vercel_snapshot_cleanup_unqualified' });
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
  });
  it('confirms full absence when the name and its resource-scoped snapshots are absent', async () => {
    const { client } = fixture(url => url.pathname === '/v2/sandboxes/snapshots' ? json(emptyPage) : json({}, 404));
    expect(await client.inspect(resource)).toMatchObject({ availability: 'absent', storage: 'lost' });
  });
  it('preserves trailing spaces in the actually observed guest home', async () => {
    const home = '/home/custom guest ';
    const { client } = fixture((url, init) => {
      if (url.pathname.endsWith('/cmd') || /\/cmd\/cmd_one$/.test(url.pathname)) {
        return json({ command: { id: 'cmd_one', sessionId: session.id, exitCode: init?.method === 'POST' ? null : 0 } });
      }
      if (url.pathname.endsWith('/logs')) return new Response(JSON.stringify({ stream: 'stdout', data: 'Linux\nx86_64\n' + home + '\n' }) + '\n');
      return json({ sandbox: named(), session, routes: [], resumed: false });
    });
    expect(await client.bootstrap(resource)).toMatchObject({ guestHome: { homeDir: home, happyHomeDir: home + '/.happier' } });
  });

  it('retains a dropped create response and recovers one exact tagged allocation without another POST', async () => {
    let created = false;
    const { client, calls } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (url.pathname === '/v4/sandboxes') { created = true; throw new Error('response dropped private vendor body'); }
      return created ? json({ sandbox: named(), session, resumed: false, routes: [] }) : json({}, 404);
    });
    const pending = await client.acquire(launch, resource.managedId);
    expect(pending).toEqual({ kind: 'pending', nativeOperationRef: reference({ kind: 'acquire', name: resource.name, managedId: resource.managedId, ...scope }) });
    const operation = { kind: 'acquire' as const, name: resource.name, managedId: resource.managedId, ...scope };
    expect(await client.recover(operation)).toEqual({ kind: 'bound', resource: reference(resource) });
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
    const create = calls.find(call => call.url.pathname === '/v4/sandboxes');
    expect(JSON.parse(String(create!.init!.body))).toMatchObject({ persistent: true, snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, deleteEvicted: true, expiration: 0 }, architecture: 'amd64' });
    expect(JSON.stringify(pending)).not.toContain('private');
  });
  it('observes timed-out retained stop without waking or doing guest IO', async () => {
    const { client, calls } = fixture(url => url.pathname.includes('/snapshots/')
      ? json({ snapshot }) : json({ sandbox: named('stopped'), session: { ...session, status: 'stopped' }, resumed: false, routes: [] }));
    expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
    expect(calls).toHaveLength(2);
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
    expect(calls[0]!.url.searchParams.get('resume')).toBe('false');
    expect(calls.some(call => /cmd|fs/.test(call.url.pathname))).toBe(false);
  });
  it.each(['missing', 'expired'])('never replaces a stopped sandbox whose snapshot is %s', async state => {
    const { client, calls } = fixture(url => url.pathname.includes('/snapshots/')
      ? state === 'missing' ? json({}, 404) : json({ snapshot: { ...snapshot, expiresAt: 1999 } })
      : json({ sandbox: named('stopped'), session, resumed: false, routes: [] }));
    expect(await client.power(resource, 'resume')).toEqual({ kind: 'refused', code: 'vercel_snapshot_unavailable' });
    expect(calls.every(call => call.url.searchParams.get('resume') !== 'true' && (!call.init?.method || call.init.method === 'GET'))).toBe(true);
  });
  it('does not operate a reused name with a different creation fact', async () => {
    const { client, calls } = fixture(() => json({ sandbox: { ...named(), createdAt: 9999 }, session, resumed: false, routes: [] }));
    expect(await client.power(resource, 'stop')).toEqual({ kind: 'refused', code: 'vercel_identity_mismatch' });
    expect(calls).toHaveLength(1);
  });
  it('refuses Suspend without any HTTP effect', async () => {
    const { client, calls } = fixture(() => { throw new Error('no HTTP'); });
    expect(await client.power(resource, 'suspend')).toEqual({ kind: 'refused', code: 'vercel_intent_unsupported' });
    expect(calls).toEqual([]);
  });
  it('keeps cancellation after create as uncertain native custody', async () => {
    const controller = new AbortController();
    const { client } = fixture((url, init) => {
      if (url.pathname.startsWith('/v2/teams/')) return json({ id: scope.teamId, billing: { plan: 'hobby' } });
      if (init?.method === 'POST') { controller.abort(); throw new Error('aborted response'); }
      return json({}, 404);
    }, controller.signal);
    expect(await client.acquire(launch, resource.managedId)).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { managedId: resource.managedId } } });
  });
  it('retains recovery when the credential is unavailable rather than claiming absence', async () => {
    const { client } = fixture(() => json({}, 401));
    const operation: VercelOperation = { kind: 'acquire', name: resource.name, managedId: resource.managedId, ...scope };
    expect(await client.recover(operation)).toEqual({ kind: 'pending', nativeOperationRef: reference(operation) });
    expect(await client.inspect(resource)).toMatchObject({ availability: 'unavailable', reason: 'credential_unavailable' });
  });
  it('keeps deletion incomplete while exact owned snapshot survives', async () => {
    const operation: VercelOperation = { kind: 'delete', resource, phase: 'delete', snapshotIds: [snapshot.id] };
    const { client, calls } = fixture(url => url.pathname.includes('/snapshots/') ? json({ snapshot }) : json({}, 404));
    expect(await client.destroy({ nativeOperation: operation })).toEqual({ kind: 'accepted', nativeOperationRef: reference(operation) });
    expect(await client.cleanup(operation)).toEqual({ kind: 'retryable' });
    expect(calls.filter(call => call.init?.method === 'DELETE')).toEqual([]);
  });
  it('observes deletion only after both sandbox and exact snapshots are gone', async () => {
    const operation: VercelOperation = { kind: 'delete', resource, phase: 'delete', snapshotIds: [snapshot.id] };
    const { client, calls } = fixture(() => json({}, 404));
    expect(await client.cleanup(operation)).toEqual({ kind: 'confirmed' });
    expect(calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true);
  });
  it('keeps unknown snapshot cleanup incomplete', async () => {
    const operation: VercelOperation = { kind: 'delete', resource, phase: 'delete', snapshotIds: [snapshot.id] };
    const { client } = fixture(url => url.pathname.includes('/snapshots/') ? json({}, 503) : json({}, 404));
    expect(await client.cleanup(operation)).toMatchObject({ kind: 'unknown' });
  });
  it('enforces the observed account plan before allocation', async () => {
    const { client, calls } = fixture(url => url.pathname.startsWith('/v2/teams/')
      ? json({ id: scope.teamId, billing: { plan: 'hobby' } }) : json({}, 404));
    expect(await client.acquire({ ...launch, timeoutMs: 86_400_000 }, resource.managedId)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false);
  });
});
