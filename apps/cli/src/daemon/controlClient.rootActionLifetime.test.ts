import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDaemonSignedRootActionExecution } from './controlClient';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

const contributedActionInput = { action: { pluginId: 'qa.collection-detail', localId: 'set-complete' }, input: { rowId: 'release-guide', completed: true } };
const pluginInstallInput = { path: '/plugin', kind: 'path', dev: true };
const pluginControlActions = [
  'plugins.install', 'plugins.uninstall', 'plugins.dev.submit', 'plugins.dev.unregister',
  'plugins.reload', 'plugins.change.status', 'plugins.list',
] as const;

describe('signed root Action acknowledgement', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('preserves every strict Action error facet without disclosing daemon-private fields', async () => {
    const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'goal_unavailable', error: 'goal_unavailable',
      details: { reason: 'not_ready' }, goalControlFailure: { phase: 'native_effect' } });
    vi.stubGlobal('fetch', async () => Response.json({ ...failure, daemonPrivate: 'not-public' }));
    await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.goal.get', input: { sessionId: 'created-session' } }, {
      target: { pid: process.pid, httpPort: 1 },
    })).resolves.toEqual(failure);
  });

  it('omits malformed Goal diagnostics while retaining the refusal and opaque details', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: false, errorCode: 'goal_unavailable', error: 'goal_unavailable',
      details: { reason: 'not_ready' }, goalControlFailure: { phase: 'native_effect', objective: 'private' } }));
    await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.goal.get', input: { sessionId: 'created-session' } }, {
      target: { pid: process.pid, httpPort: 1 },
    })).resolves.toEqual({ ok: false, errorCode: 'goal_unavailable', error: 'goal_unavailable', details: { reason: 'not_ready' } });
  });

  it.each(['session.wait.idle', 'ui.find', 'action.invoke', ...pluginControlActions, 'daemon.filesystem.upload', 'daemon.filesystem.download', 'daemon.filesystem.copy'] as const)('lets %s return after the generic transport deadline', async (actionId) => {
    vi.useFakeTimers();
    // Clock and HTTP are system boundaries; native AbortSignal timers use a separate clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', (_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ ok: true, result: { idle: true, observedAt: 301000 } })), 301000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    }));
    const result = requestDaemonSignedRootActionExecution({ actionId, input: actionId === 'ui.find'
      ? { op: 'read' } : actionId === 'action.invoke' ? contributedActionInput : actionId === 'plugins.install' ? pluginInstallInput
        : actionId === 'daemon.filesystem.copy' ? { kind: 'prepared_transfer' } : { sessionId: 'created-session', timeoutSeconds: 600 } }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    const observed = result.then((value) => value);
    await vi.advanceTimersByTimeAsync(301000);
    expect(await observed).toMatchObject({ ok: true, result: { idle: true } });
  });
  it.each(['session.spawn_new', 'action.invoke', 'plugins.install'] as const)('preserves an explicit %s deadline without retrying the uncertain effect', async (actionId) => {
    const acceptedRequests: string[] = [];
    const server = createServer((request) => {
      request.resume();
      request.on('end', () => { acceptedRequests.push('effect-accepted'); });
      // Real HTTP loss after the write committed: no response is sent.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      const input = SessionSpawnNewInputV2Schema.parse({
        creationKey: 'root-create-ack', executionTarget: { serverId: 'server-local', machineId: 'machine-local' },
        directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      });
      const result = await requestDaemonSignedRootActionExecution({ actionId,
        input: actionId === 'action.invoke' ? contributedActionInput : actionId === 'plugins.install' ? pluginInstallInput : input }, {
        target: { pid: process.pid, httpPort: address.port }, timeoutMs: 100,
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      expect(acceptedRequests).toEqual(['effect-accepted']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps an ordinary bounded root Action under its existing transport deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', (_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const pending = requestDaemonSignedRootActionExecution({ actionId: 'session.spawn_new', input: {} }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
  });

  it.each(['action.invoke', 'plugins.install'] as const)('cancels %s observation when its caller aborts', async (actionId) => {
    let accepted!: () => void;
    const requestAccepted = new Promise<void>((resolve) => { accepted = resolve; });
    const server = createServer((request) => {
      request.resume();
      request.on('end', accepted);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const controller = new AbortController();
    try {
      const pending = requestDaemonSignedRootActionExecution({ actionId, input: actionId === 'action.invoke' ? contributedActionInput : pluginInstallInput }, {
        target: { pid: process.pid, httpPort: address.port }, signal: controller.signal,
      });
      await requestAccepted;
      controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports an idle observation deadline as timeout, not a daemon outage', async () => {
    const server = createServer((request) => request.resume());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.wait.idle', input: { sessionId: 'created-session' } }, {
        target: { pid: process.pid, httpPort: address.port }, timeoutMs: 100,
      })).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
