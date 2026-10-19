import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('daemon workspace-sync production composition', () => {
  it('constructs the registered-machine runtime through the production owner and stops that same instance', async () => {
    const source = await readFile(fileURLToPath(new URL('./startDaemon.ts', import.meta.url)), 'utf8');

    expect(source.includes("from './startup/createProductionDaemonWorkspaceSyncRuntime'")).toBe(true);
    expect(source.includes("from './peer/iroh/workspaceMachineCarrierTunnelOpen'")).toBe(true);
    expect(source).not.toContain('createWorkspaceMachineCarrierStreamOpen');
    expect(source).toContain('createWorkspaceSyncRuntime: async');
    expect(source).toContain('await createProductionDaemonWorkspaceSyncRuntime({');
    expect(source).toMatch(/createProductionDaemonWorkspaceSyncRuntime\(\{[\s\S]*openMachineCarrierTunnel/u);
    expect(source).toMatch(/drainBackgroundServerWork:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?await\s+stopWorkspaceSyncRuntime\(\)/u);
    expect(source).toContain('createDaemonWorkspaceSyncRuntimeCustody<ProductionDaemonWorkspaceSyncRuntime');
    expect(source).toContain('workspaceSyncRuntimeCustody.acquire(registeredMachineId');
  });
});
