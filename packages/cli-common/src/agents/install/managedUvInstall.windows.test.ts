import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { managedAcpInstallId } from '../managedAcpInstallIdentity.js';
import { installManagedUvAgent, resolveManagedUvAgentCommand, uninstallManagedUvAgent } from './managedUvInstall.js';
import type { execFileWithDeadline } from '../../process/index.js';

it('uses managed Windows executables and literal argv without a shell', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const root = await mkdtemp(join(tmpdir(), 'happier-p9d-uv-windows-'));
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('USERNAME', 'fixture-user');
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  // Windows ACL application is an OS boundary unavailable on this Linux host.
  const acl = vi.spyOn(childProcess, 'spawnSync').mockImplementation(command => {
    const name = String(command);
    // This Linux host has no Windows process/host identity fact; those native
    // OS probes fail. The real lock owner retains its unavailable-fact policy.
    return { pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: name.endsWith('icacls.exe') ? 0 : 1, signal: null };
  });
  syncBuiltinESMExports();
  try {
    const uv = join(root, 'tools', 'uv', 'current', 'bin', 'uv.exe');
    await mkdir(dirname(uv), { recursive: true }); await writeFile(uv, 'vendor executable');
    const env = { HAPPIER_HOME_DIR: root, Path: '' };
    const spec = { id: managedAcpInstallId({ accountId: 'alice', definitionId: 'uv-agent', version: '1.0' }),
      definitionId: 'uv-agent', title: 'Uv Agent', package: 'agent-package', version: '1.0', command: 'agent' };
    const runCommand: typeof execFileWithDeadline = async (command, args, options) => {
      expect(command).toBe(uv);
      expect(options.shell).toBeUndefined();
      expect(options.windowsHide).toBe(true);
      if (args[1] === 'install') {
        expect(args).toEqual(['tool', 'install', 'agent-package==1.0']);
        await writeFile(join(options.env!.UV_TOOL_BIN_DIR!, 'agent.exe'), 'installed executable');
      } else expect(args).toEqual(['tool', 'uninstall', 'agent-package']);
      return { stdout: '', stderr: '' };
    };
    await installManagedUvAgent({ spec, env, runCommand });
    expect(await resolveManagedUvAgentCommand(spec, env)).toBe(join(root, 'tools', 'providers', spec.id, 'current', 'bin', 'agent.exe'));
    await uninstallManagedUvAgent(spec, env, undefined, runCommand);
  } finally { acl.mockRestore(); syncBuiltinESMExports(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform); await rm(root, { recursive: true, force: true }); }
});
