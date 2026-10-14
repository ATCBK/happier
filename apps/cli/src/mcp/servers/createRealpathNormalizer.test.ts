import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { resolveSessionCapabilitiesForDirectory } from './resolveSessionCapabilitiesForDirectory';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  realpathSync: (value: unknown) => String(value).endsWith('session') ? 'c:\\repo\\x'
    : String(value).endsWith('neighbour') ? 'c:\\repo2\\x' : 'C:\\Repo',
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
});

describe('createRealpathNormalizer Windows MCP resolution', () => {
  it('applies a folder binding when the session realpath has different drive and directory case', () => {
    // OS boundaries: realpath spelling and the platform, with the MCP resolution kept real.
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [{ id: 'server-1', name: 'example', transport: 'stdio', stdio: { command: 'example', args: [] }, env: {}, createdAt: 0, updatedAt: 0 }],
      bindings: [{ id: 'binding-1', serverId: 'server-1', enabled: true,
        target: { t: 'workspace', machineId: 'machine-1', workspaceRoot: 'C:\\Linked' }, createdAt: 0, updatedAt: 0 }],
    });
    const skills = { items: [{ skillId: 'skill', name: 'skill' }], rules: [{ ...settings.bindings[0]!, skillId: 'skill' }] };
    const resolved = resolveSessionCapabilitiesForDirectory({ settings, skills, machineId: 'machine-1', directory: 'session' });
    expect(resolved.selectedServersByName.example?.bindingId).toBe('binding-1');
    expect(resolved.skills.items[0]).toMatchObject({ selected: true, reason: 'rule_on' });
    const neighbour = resolveSessionCapabilitiesForDirectory({ settings, skills, machineId: 'machine-1', directory: 'neighbour' });
    expect(neighbour.mcp.items[0]).toMatchObject({ selected: false, reason: 'no_rule' });
    expect(neighbour.skills.items[0]).toMatchObject({ selected: false, reason: 'no_rule' });
  });
});
