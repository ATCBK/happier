import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedResourceV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { runManagedMachineEnrollment, type ManagedNativeBootstrapIO } from './enrollment';

const execFileAsync = promisify(execFile);

const resource = ManagedResourceV1Schema.parse({ contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } });
const correlation = { homeId: 'srv_managed_home', managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1, controller: { machineId: 'controller-1', installationId: 'installation-1' }, resource };
const machine = ManagedMachineV1Schema.parse({
  id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'account-1',
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
  controller: correlation.controller, allocation: 'bound', creationState: 'active', resource,
  desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId, canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] }, authority: 'trusted_enrollment' });
const carrier = { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } };

async function withReleaseMirror(run: (releases: string[]) => Promise<void>) {
  const releases: string[] = [];
  // GitHub is the external boundary; enrollment, task composition and HTTP selection stay real.
  const mirror = createServer((request, response) => {
    // Loopback discovery can probe `/`; only release API requests belong to
    // this installer boundary. Unset-override cases below require the tag read.
    if (request.url?.startsWith('/repos/')) releases.push(request.url);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => { mirror.once('error', reject); mirror.listen(0, '127.0.0.1', resolve); });
  try {
    const address = mirror.address();
    if (!address || typeof address === 'string') throw new Error('Release mirror was not listening');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', `http://127.0.0.1:${address.port}`);
    await run(releases);
  } finally {
    await new Promise<void>((resolve, reject) => mirror.close(error => error ? reject(error) : resolve()));
  }
}

describe('runManagedMachineEnrollment', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('delivers the operator payload through native enrollment and executes the promoted CLI', async () => {
    if (process.platform === 'win32') return; // Managed guest installation targets POSIX.
    const root = await mkdtemp(join(tmpdir(), 'happier-native-source-payload-'));
    const payloadRoot = join(root, 'payload');
    const guestHome = join(root, 'guest');
    try {
      await mkdir(payloadRoot);
      await mkdir(guestHome);
      // The executable is the OS boundary; it records invocation and returns no auth material.
      const executable = '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/invoked-args"\n';
      await writeFile(join(payloadRoot, 'happier'), executable);
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', ` ${payloadRoot} `);
      const native: ManagedNativeBootstrapIO = {
        exec: async ({ command }) => {
          const result = await execFileAsync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: guestHome } });
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        },
        putFile: async ({ path, bytes }) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
      };
      // Installation must reach the real recipe's auth consumer; empty output is deliberately invalid.
      await withReleaseMirror(async (releases) => {
        await expect(runManagedMachineEnrollment({ correlation, target, carrier, channel: 'stable' }, {
          readCurrentManagedRow: async () => machine, native,
        })).rejects.toMatchObject({ code: 'invalid_cli_response' });
        expect(releases).toEqual([]);
      });
      expect(await readFile(join(guestHome, '.happier/cli/current/happier'), 'utf8')).toBe(executable);
      expect((await readFile(join(guestHome, 'invoked-args'), 'utf8')).split('\n')).toEqual(expect.arrayContaining([
        'auth', 'request', '--remote-enrollment', '--home-target-stdin', '--managed-enrollment-stdin',
      ]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a bad operator payload with a typed failure before delivery or release fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-invalid-payload-'));
    try {
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      await withReleaseMirror(async (releases) => {
        await expect(runManagedMachineEnrollment({ correlation, target, carrier }, {
          readCurrentManagedRow: async () => machine,
          native: {
            exec: async () => ({ status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' }),
            putFile: async () => { throw new Error('Invalid payload must not be delivered'); },
          },
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(releases).toEqual([]);
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['preview', undefined, 'cli-preview'],
    ['dev', undefined, 'cli-dev'],
    ['preview', 'stable', 'cli-stable'],
  ] as const)('selects the %s controller channel unless explicitly overridden by %s through the real installer', async (hostChannel, channel, releaseTag) => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', '');
    vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', hostChannel);
    await withReleaseMirror(async (releases) => {
      await expect(runManagedMachineEnrollment({ correlation, target, carrier, ...(channel ? { channel } : {}) }, {
        readCurrentManagedRow: async () => machine,
        native: { exec: async () => ({ status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' }),
          putFile: async () => { throw new Error('No payload may be delivered after release lookup fails'); } },
      })).rejects.toThrow(/first-party-release/);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toBe(`/repos/happier-dev/happier/releases/tags/${releaseTag}`);
    });
  });
  it('retries an unconfirmed native boot update after enrollment using the same installed binary and Machine without reinstalling or pairing', async () => {
    const bootCarrier = { ...carrier, guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } };
    const requests: unknown[] = [];
    let attempt = 0;
    const dependencies = { readCurrentManagedRow: async () => ({ ...machine, enrolledMachineId: 'ordinary-machine' }),
      native: { exec: async (request: { command: string; processConfig?: unknown }) => {
        requests.push(request);
        if (!request.processConfig) throw new Error('Retry must not reinstall or re-enroll the ordinary Machine');
        return { status: attempt++ === 0 ? 1 : 0, stdout: '', stderr: '' };
      }, putFile: async () => { throw new Error('Retry must not deliver another installer or pairing payload'); } } };
    await expect(runManagedMachineEnrollment({ correlation, target, carrier: bootCarrier }, dependencies)).rejects.toMatchObject({ code: 'native_boot_unconfirmed' });
    expect(await runManagedMachineEnrollment({ correlation, target, carrier: bootCarrier }, dependencies)).toEqual({ machineId: 'ordinary-machine' });
    expect(requests).toEqual([expect.objectContaining({ command: expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start-sync'"),
      processConfig: { environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' } } }), expect.anything()]);
    expect(requests[1]).toEqual(requests[0]);
  });
  it('runs native installer observations under the declared persistent guest home, not the image default home', async () => {
    const commands: string[] = [];
    await expect(runManagedMachineEnrollment({ correlation, target, carrier: { ...carrier,
      guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } } }, {
      readCurrentManagedRow: async () => machine,
      native: { exec: async ({ command }) => { commands.push(command); return { status: 1, stdout: '', stderr: '' }; }, putFile: async () => {} },
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(commands[0]).toContain("HOME='/persistent/home'");
    expect(commands[0]).toContain("HAPPIER_HOME_DIR='/persistent/home/.happier'");
    expect(commands[0]).toContain('uname -s; uname -m;');
  });
  it('refuses retired enrollment without sending a private payload to the guest', async () => {
    let nativeCalls = 0;
    await expect(runManagedMachineEnrollment({ correlation, target, carrier }, {
      readCurrentManagedRow: async () => ({ ...machine, creationState: 'canceled' }),
      native: {
        exec: async () => { nativeCalls++; return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { nativeCalls++; },
      },
    })).rejects.toMatchObject({ code: 'enrollment_retired' });
    expect(nativeCalls).toBe(0);
  });

  it('refuses a replaced native identity without installing or reacquiring', async () => {
    let nativeCalls = 0;
    await expect(runManagedMachineEnrollment({ correlation, target, carrier }, {
      readCurrentManagedRow: async () => ({ ...machine, resource: { ...resource, value: { nativeId: 'another-guest' } } }),
      native: {
        exec: async () => { nativeCalls++; return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { nativeCalls++; },
      },
    })).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(nativeCalls).toBe(0);
  });
});
