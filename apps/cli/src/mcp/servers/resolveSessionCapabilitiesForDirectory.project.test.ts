import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { resolveSessionCapabilitiesForDirectory } from './resolveSessionCapabilitiesForDirectory';

const credentials = { token: 'project-reach', encryption: null };
const serverId = 'project-home';
const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{ id: 'tools', name: 'tools', transport: 'stdio',
  stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
  bindings: [{ id: 'project-on', serverId: 'tools', target: { t: 'project', projectKey: 'shared-project' },
    enabled: true, createdAt: 1, updatedAt: 1 }] });
function rows() {
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  return vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows:
    [{ id: 'mac-checkout', machineId: 'mac', rootPath: '/Users/dev/project', projectKey: 'shared-project' },
      { id: 'linux-checkout', machineId: 'linux', rootPath: '/srv/project', projectKey: 'shared-project' },
      { id: 'other-checkout', machineId: 'linux', rootPath: '/srv/other', projectKey: 'other-project' }].map(ref => {
      const key = { kind: 'workspace-ref', serverId, id: ref.id };
      return { key, revision: 1, content: { t: 'plain', v: { key, value: { ...ref, serverId, createdAtMs: 1 } } } };
    }) } });
}
afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });
describe('Account Project capability reach', () => {
  it('selects the same Account Project on different roots and machines, but not another Project', async () => {
    rows();
    for (const [machineId, workspaceId, directory, projectId, selected] of [
      ['mac', 'mac-checkout', '/Users/dev/project', 'shared-project', true],
      ['linux', 'linux-checkout', '/srv/project', 'shared-project', true],
      ['linux', 'other-checkout', '/srv/other', 'other-project', false],
    ] as const) {
      const result = await resolveSessionCapabilitiesForDirectory({ settings, machineId, directory, agentId: 'codex',
        agentAcceptsUserMcp: true, sessionProject: { credentials, serverId, metadata: { workspaceId, projectId, path: directory } } });
      expect(result.mcp.items[0]?.selected).toBe(selected);
    }
  });
  it('keeps unreadable association pending rather than returning an Off decision', async () => {
    rows().mockRejectedValue(new Error('unreachable'));
    await expect(Promise.resolve().then(() => resolveSessionCapabilitiesForDirectory({ settings, machineId: 'linux', directory: '/srv/project',
      agentId: 'codex', agentAcceptsUserMcp: true,
      sessionProject: { credentials, serverId, metadata: { workspaceId: 'linux-checkout', projectId: 'shared-project' } },
    }))).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
  });
  it('uses the exact Account checkout for directory-only Sessions, with the same MCP and skill Project rules', async () => {
    rows();
    const result = await resolveSessionCapabilitiesForDirectory({ settings,
      skills: { items: [{ skillId: 'lint', name: 'lint' }], rules: [
        { id: 'skill-everywhere', skillId: 'lint', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
        { id: 'skill-project-off', skillId: 'lint', target: { t: 'project', projectKey: 'shared-project' }, enabled: false, createdAt: 1, updatedAt: 1 },
      ] }, machineId: 'linux', directory: '/srv/project', agentId: 'codex', agentAcceptsUserMcp: true,
      sessionProject: { credentials, serverId, metadata: { path: '/srv/project' } } });
    expect(result.mcp.items[0]).toMatchObject({ selected: true, reason: 'rule_on' });
    expect(result.skills.items[0]).toMatchObject({ selected: false, reason: 'rule_off' });
  });
  it('does not use directory containment to invent an association for a nested unassociated directory', async () => {
    const request = rows();
    const result = await resolveSessionCapabilitiesForDirectory({ settings, machineId: 'linux', directory: '/srv/project/child',
      agentId: 'codex', agentAcceptsUserMcp: true, sessionProject: { credentials, serverId, metadata: {} } });
    expect(result.mcp.items[0]?.selected).toBe(false);
    expect(request).toHaveBeenCalled();
  });
  it('resolves skill Project reach through the same association owner', async () => {
    rows();
    const result = await resolveSessionCapabilitiesForDirectory({ settings: { ...settings, servers: [], bindings: [] },
      machineId: 'linux', directory: '/srv/project', agentId: 'codex', agentAcceptsUserMcp: false,
      skills: { items: [{ skillId: 'lint', name: 'lint' }], rules: [{ id: 'skill-project', skillId: 'lint',
        target: { t: 'project', projectKey: 'shared-project' }, enabled: true, createdAt: 1, updatedAt: 1 }] },
      sessionProject: { credentials, serverId, metadata: { workspaceId: 'linux-checkout', projectId: 'shared-project' } },
    });
    expect(result.skills.items[0]).toMatchObject({ selected: true, decidedBy: { ruleId: 'skill-project', target: 'project' } });
  });
  it.each(['unsupported', 'managed_off', 'excluded', 'other_agent', 'orphan', 'no_project'] as const)(
    'does not read Project rows for %s items', async guard => {
      const request = rows();
      const result = await resolveSessionCapabilitiesForDirectory({ settings: { ...settings, bindings: guard === 'no_project' ? []
        : settings.bindings.map(rule => ({ ...rule, ...(guard === 'orphan' ? { serverId: 'absent' } : {}),
          ...(guard === 'other_agent' ? { agentId: 'gemini' } : {}) })) },
        machineId: 'linux', directory: '/srv/project', agentId: 'codex', agentAcceptsUserMcp: guard !== 'unsupported',
        selection: { mcp: { v: 1, managedServersEnabled: guard !== 'managed_off', forceIncludeServerIds: [],
          forceExcludeServerIds: guard === 'excluded' ? ['tools'] : [] } },
        sessionProject: { credentials, serverId, metadata: { workspaceId: 'linux-checkout', projectId: 'shared-project' } },
      });
      expect(result.mcp.items[0]?.selected).toBe(false);
      expect(request).not.toHaveBeenCalled();
    });
});
