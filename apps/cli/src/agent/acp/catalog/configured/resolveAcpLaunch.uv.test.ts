import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { normalizePackageRunnerInvocation } from '@/packagedRuntime/packageRunner/normalizePackageRunnerInvocation';
import { ensureAcpLaunchForSession, resolveAcpLaunch } from './resolveAcpLaunch';

const uvNetwork = vi.hoisted(() => ({ origin: '' }));
// The unavailable-download case exercises the actual downloader's HTTP failure,
// rather than adding a runtime gate solely to suppress acquisition in tests.
vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) {
    if (url.hostname !== 'releases.astral.sh' || !uvNetwork.origin) throw new Error('Unexpected release download');
    return httpRequest(new URL(url.pathname, uvNetwork.origin), options, callback);
  },
}));

describe('managed uv through the canonical launch and install job owners', () => {
  it.skipIf(process.platform === 'win32')('normalizes uvx and uv tool run without selecting system uv or a JavaScript runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-p9d-uv-runner-'));
    const fixture = createServer((_request, response) => { response.writeHead(503).end(); });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    uvNetwork.origin = `http://127.0.0.1:${address.port}`;
    try {
      const uv = join(root, 'tools', 'uv', 'current', 'bin', 'uv');
      await mkdir(dirname(uv), { recursive: true }); await writeFile(uv, '#!/bin/sh\nexit 0\n'); await chmod(uv, 0o755);
      const env = { HAPPIER_HOME_DIR: root, PATH: '' };
      for (const input of [{ command: 'uvx', args: ['pkg==1.0'] }, { command: 'uv', args: ['tool', 'run', 'pkg==1.0'] }]) {
        expect(await normalizePackageRunnerInvocation({ ...input, processEnv: env })).toMatchObject({
          command: uv, args: ['tool', 'run', 'pkg==1.0'], cwdPolicy: 'neutral',
          env: { UV_PYTHON_PREFERENCE: 'only-managed' },
        });
      }
      expect(await normalizePackageRunnerInvocation({ command: 'uv', args: ['pip', 'install', 'pkg'], processEnv: env })).toBeNull();
      await rm(join(root, 'tools', 'uv'), { recursive: true });
      expect(await normalizePackageRunnerInvocation({ command: 'uvx', args: ['pkg'], processEnv: env })).toBeNull();
    } finally { uvNetwork.origin = ''; fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('installs through jobs, first-use keeps side-by-side pins and Accounts, and uninstall is guarded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-p9d-uv-jobs-'));
    const log = join(root, 'calls.jsonl');
    const uv = join(root, 'tools', 'uv', 'current', 'bin', 'uv');
    await mkdir(dirname(uv), { recursive: true });
    // The vendor executable is the external process boundary. Real job,
    // launch, lock, receipt, inventory and remover logic run around it.
    await writeFile(uv, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(process.env.UV_FIXTURE_LOG, JSON.stringify({args:process.argv.slice(2),tools:process.env.UV_TOOL_DIR,bin:process.env.UV_TOOL_BIN_DIR})+'\\n');
if (process.env.UV_FIXTURE_FAIL === '1') process.exit(1);
if (process.argv[3] === 'install') { fs.mkdirSync(process.env.UV_TOOL_DIR,{recursive:true}); fs.mkdirSync(process.env.UV_TOOL_BIN_DIR,{recursive:true}); fs.writeFileSync(path.join(process.env.UV_TOOL_BIN_DIR,'actual-agent'),'#!/bin/sh\\nexit 0\\n',{mode:0o755}); if(process.env.UV_FIXTURE_MULTI==='1') fs.writeFileSync(path.join(process.env.UV_TOOL_BIN_DIR,'fixture-agent'),'#!/bin/sh\\nexit 0\\n',{mode:0o755});
if(process.env.UV_FIXTURE_PYTHON==='1') { fs.mkdirSync(process.env.UV_PYTHON_INSTALL_DIR,{recursive:true});const python=path.join(process.env.UV_PYTHON_INSTALL_DIR,'python');fs.writeFileSync(python,'#!/bin/sh\\nprintf python-ready\\n',{mode:0o755});fs.writeFileSync(path.join(process.env.UV_TOOL_BIN_DIR,'actual-agent'),'#!/bin/sh\\nexec "'+python+'" "$@"\\n',{mode:0o755}); } }
`); await chmod(uv, 0o755);
    const env = { ...process.env, HAPPIER_HOME_DIR: root, PATH: '', UV_FIXTURE_LOG: log };
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'uv-agent', name: 'uv-agent', title: 'Uv Agent',
      launch: { kind: 'uv', package: 'fixture-agent', version: '1.0', command: 'actual-agent', args: ['--acp'] }, createdAt: 1, updatedAt: 1 });
    let inUse = false;
    const owner = createAgentInstallJobOwner({ accountId: 'alice', env,
      readTrackedSessions: () => inUse ? [{ pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: root,
        agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: definition.id } } }] : [],
      readRegistry: () => ({ agents: [{ id: 'custom-acp', pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId,
        identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 }] }),
      readAcpCatalog: () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: [definition] } }),
    });
    const params = { accountId: 'alice', definition, platform: process.platform, arch: process.arch, env };
    const run = async (intent: 'install' | 'uninstall') => {
      const started = DaemonAgentInstallStartResponseSchema.parse(owner.start({ agentId: 'custom-acp', definitionId: definition.id,
        intent, consent: { vendorRecipe: false } }));
      expect(started.ok).toBe(true); if (!started.ok) throw new Error('Job rejected');
      await vi.waitFor(() => expect(owner.read({ jobId: started.jobId, cursor: 0 })).toMatchObject({ ok: true, done: true }));
      return DaemonAgentInstallReadResponseSchema.parse(owner.read({ jobId: started.jobId, cursor: 0 }));
    };
    try {
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'needs_install', installable: { source: { packageManager: 'managed_uv' } } });
      expect(await run('install')).toMatchObject({ outcome: { kind: 'succeeded', version: '1.0' } });
      const old = await ensureAcpLaunchForSession({ ...params, settings: accountSettingsParse({}), machineId: 'fixture' });
      expect(old.args).toEqual(['--acp']);
      inUse = true;
      const nextDefinition = AcpBackendDefinitionV1Schema.parse({ ...definition, launch: { ...definition.launch, version: '2.0' } });
      const next = await ensureAcpLaunchForSession({ ...params, definition: nextDefinition, settings: accountSettingsParse({}), machineId: 'fixture' });
      const foreign = await ensureAcpLaunchForSession({ ...params, accountId: 'bob', settings: accountSettingsParse({}), machineId: 'fixture' });
      expect(new Set([old.command, next.command, foreign.command]).size).toBe(3);
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'ready', command: old.command });
      expect(DaemonAgentInstallStartResponseSchema.parse(owner.start({ agentId: 'custom-acp', definitionId: definition.id,
        intent: 'uninstall', consent: { vendorRecipe: false } }))).toMatchObject({ ok: false, errorCode: 'in_use' });
      inUse = false;
      expect(await run('uninstall')).toMatchObject({ outcome: { kind: 'succeeded' } });
      expect(await resolveAcpLaunch(params)).toMatchObject({ kind: 'needs_install' });
      expect(await resolveAcpLaunch({ ...params, accountId: 'bob' })).toMatchObject({ kind: 'ready', command: foreign.command });
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(calls[0].args).toEqual(['tool', 'install', 'fixture-agent==1.0']);
      expect(calls[0].tools).toContain(root);
      expect(calls.some(call => call.args.join(' ') === 'tool uninstall fixture-agent')).toBe(true);
      const failureParams = { ...params, accountId: 'failure-account', env: { ...env, UV_FIXTURE_FAIL: '1' } };
      await expect(ensureAcpLaunchForSession({ ...failureParams, settings: accountSettingsParse({}), machineId: 'fixture' })).rejects.toThrow();
      // A failed external install must remain retryable through the same
      // first-use owner, rather than strand an unreceipted current directory.
      const recovered = await ensureAcpLaunchForSession({ ...failureParams, env, settings: accountSettingsParse({}), machineId: 'fixture' });
      expect(recovered.command).not.toBe(foreign.command);
      const defaultDefinition = AcpBackendDefinitionV1Schema.parse({ ...definition, launch: { ...definition.launch, package: 'Fixture_Agent', command: undefined } });
      const defaultLaunch = await ensureAcpLaunchForSession({ ...params, accountId: 'default-command', definition: defaultDefinition,
        env: { ...env, UV_FIXTURE_MULTI: '1' }, settings: accountSettingsParse({}), machineId: 'fixture' });
      expect(defaultLaunch.command).toBe(join(dirname(defaultLaunch.command), 'fixture-agent'));
      const pythonLaunch = await ensureAcpLaunchForSession({ ...params, accountId: 'python-ownership',
        env: { ...env, UV_FIXTURE_PYTHON: '1' }, settings: accountSettingsParse({}), machineId: 'fixture' });
      // Removing the shared bootstrap/cache must not strand a retained Agent's
      // interpreter. Its runtime belongs to the same guarded version root.
      await rm(join(root, 'tools', 'uv'), { recursive: true, force: true });
      expect((await promisify(execFile)(pythonLaunch.command, [...pythonLaunch.args], {
        env: { ...env, ...pythonLaunch.runtimeEnv },
      })).stdout.trim()).toBe('python-ready');
    } finally { await owner.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
});
