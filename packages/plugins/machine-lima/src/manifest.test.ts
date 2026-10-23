import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { LIMA_PLUGIN } from './manifest.js';

const resource = {
  instance: 'happier-action-test', store: '/private/lima-test', image: 'https://example.test/ubuntu.img',
  arch: 'aarch64', vmType: 'vz', cpus: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3, mounts: [],
};
const native = {
  name: resource.instance, dir: `${resource.store}/${resource.instance}`, status: 'Running',
  arch: resource.arch, vmType: resource.vmType, cpus: resource.cpus, memory: resource.memoryBytes, disk: resource.diskBytes,
  config: { images: [{ location: resource.image, arch: resource.arch }], mounts: [],
    ssh: { forwardAgent: false }, containerd: { user: false, system: false } },
};

function processResult(stdout = new Uint8Array()): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

async function activatedAction(id: string, exec: Pick<ExecService, 'run'>, readyDependencies?: readonly string[]) {
  const handlers = new Map<string, ActionHandler>();
  // This fixture replaces only the external host registration/services boundary;
  // the real public authoring, native decoder and lifecycle logic stay in use.
  const api = { actions: { register(actionId: string, handler: ActionHandler) {
    handlers.set(actionId, handler); return { dispose() {} };
  } } } as unknown as PluginApi;
  await LIMA_PLUGIN.activate(api);
  const handler = handlers.get(id);
  if (!handler) throw new Error(`declared action ${id} was not activated`);
  const context = { invokedAtMs: 123, signal: new AbortController().signal,
    services: { exec, managedServices: { dependencies: { status: async (dependencyId: string): Promise<ManagedDependencyStatus> =>
      readyDependencies !== undefined && !readyDependencies.includes(dependencyId)
        ? { state: 'missing', id: dependencyId, supported: true } : { state: 'ready', id: dependencyId,
        version: dependencyId === 'lima-cli' ? '2.1.0' : '9.2.0', sourceId: 'system',
        executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: dependencyId } },
      } } } },
  } as unknown as PluginInvocationContext;
  return { handler, context };
}

describe('activated public Lima actions', () => {
  it('delivers shared-admitted exec bytes and rejects malformed input before native IO', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.args?.[0] === 'list'
        ? processResult(new TextEncoder().encode(JSON.stringify(native))) : processResult();
    } };
    const { context } = await activatedAction('exec', exec);
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN,
      services: context.services as unknown as PluginTestServicesFixture });
    try {
      await expect(kit.invokeAction('exec', { resource, argv: ['cat'], inputBase64: 'AA==\n' }, { surface: 'plugin' }))
        .rejects.toThrow();
      expect(requests).toEqual([]);
      expect(await kit.invokeAction('exec', { resource, argv: ['cat'], inputBase64: 'AB==' }, { surface: 'plugin' }))
        .toMatchObject({ stdoutBase64: '', stderrBase64: '' });
      const shell = requests.find(request => request.args?.[0] === 'shell');
      expect(shell?.stdin && Array.from(shell.stdin)).toEqual([0]);
      expect(requests.filter(request => request.stdin !== undefined)).toEqual([shell]);
    } finally { await kit.dispose(); }
  });
  it('recovers the exact reviewed guest without a native effect and refuses a foreign name', async () => {
    const launch = { ...resource, memoryGiB: 4, diskGiB: 20 };
    const { memoryBytes: _memory, diskBytes: _disk, ...choices } = launch;
    let observed: typeof native | null = native;
    const reads: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      reads.push([...(request.args ?? [])]);
      return processResult(new TextEncoder().encode(observed ? JSON.stringify(observed) : ''));
    } };
    const { handler, context } = await activatedAction('reconcile', exec);
    const input = { correlation: { managedId: 'own-row', requestId: 'own-remove', launch: choices } };
    expect(await handler(input, context)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    observed = { ...native, name: 'another-row' };
    expect(await handler(input, context)).toMatchObject({ kind: 'unknown', recovery: { reason: 'LIMA_IDENTITY_MISMATCH' } });
    observed = null;
    const recovered = await handler(input, context);
    expect(recovered).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
    const destroy = await activatedAction('destroy', exec);
    expect(await destroy.handler({ nativeOperation: resource }, destroy.context)).toEqual({ kind: 'confirmed' });
    expect(reads.every(args => args[0] === 'list')).toBe(true);
  });
  it('admits the full cold manifest through canonical SDK manifest validation', () => {
    expect(parsePluginManifest(LIMA_PLUGIN.manifest)).toMatchObject({ ok: true });
  });

  it('uses declared read-only system dependency readiness for Linux native availability', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async (request) => processResult(new TextEncoder().encode(
      request.args?.[0] === '--version' ? 'limactl version 2.1.0'
        : JSON.stringify({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] }))) };
    const unavailable = await activatedAction('check', exec, ['lima-cli', 'qemu-x86-64']);
    expect(await unavailable.handler({}, unavailable.context)).toMatchObject({ available: false, code: 'qemu_unavailable',
      status: { key: 'machineLima.presentation.qemu_unavailable' } });
    const ready = await activatedAction('check', exec, ['lima-cli', 'qemu-x86-64', 'qemu-img']);
    expect(await ready.handler({}, ready.context)).toMatchObject({ available: true,
      prerequisites: [{ requirement: { id: { localId: 'qemu-x86-64' } }, status: 'available' },
        { requirement: { id: { localId: 'qemu-img' } }, status: 'available' }] });
  });

  it('preserves binary streams and cancellation while private input stays on native stdin', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const result: PluginProcessResult = { ...processResult(new Uint8Array([255, 0])),
      stderr: new Uint8Array([128]), stdoutTruncated: true,
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } };
    const exec: Pick<ExecService, 'run'> = { run: async (request) => {
      requests.push(request);
      return request.args?.[0] === 'list' ? processResult(new TextEncoder().encode(JSON.stringify(native))) : result;
    } };
    const { handler, context } = await activatedAction('exec', exec);
    const input = new Uint8Array([0, 254, 10]);
    expect(await handler({ resource, argv: ['cat'], inputBase64: Buffer.from(input).toString('base64') }, context)).toEqual({
      termination: result.termination, stdoutBase64: '/wA=', stderrBase64: 'gA==', stdoutTruncated: true, stderrTruncated: false,
    });
    const shell = requests.find((request) => request.args?.[0] === 'shell');
    expect(shell?.stdin && Array.from(shell.stdin)).toEqual(Array.from(input));
    expect(shell?.env).toEqual({ LIMA_HOME: resource.store });
    expect(requests.filter((request) => request.stdin !== undefined)).toEqual([shell]);
  });

  it('does not confirm a private file write when the native process was canceled', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async (request) => request.args?.[0] === 'list'
      ? processResult(new TextEncoder().encode(JSON.stringify(native)))
      : { ...processResult(), termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } } };
    const { handler, context } = await activatedAction('put-file', exec);
    expect(await handler({ resource, guestPath: '/tmp/private-enrollment', bytesBase64: 'AP4K', mode: 384 }, context))
      .toEqual({ kind: 'unknown' });
  });
});
