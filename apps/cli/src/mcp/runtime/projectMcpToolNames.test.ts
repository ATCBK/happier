import { describe, expect, it } from 'vitest';
import { createHappierMcpToolNamingResolver, projectMcpToolNames } from './projectMcpToolNames';

describe('MCP transport tool naming', () => {
  it('projects the current host inventory onto a separate launch without mutating visibility or canonical names', async () => {
    const launch = { command: '/fixture', args: ['--url', 'http://127.0.0.1/'], enabledTools: ['change_title'] };
    let current = ['change_title', 'plugin_' + 'long_'.repeat(15)];
    const resolve = createHappierMcpToolNamingResolver(launch, async () => current);
    const first = (await resolve({ serverName: 'happier', toolNameMaxLength: 40 }))!;
    expect(first.launchConfig.args).toEqual([...launch.args, '--tool-name-max-length', '40']);
    expect(first.launchConfig.enabledTools).toEqual(['change_title']);
    expect(launch.args).toEqual(['--url', 'http://127.0.0.1/']);
    expect(first.tools.map(tool => tool.originalName)).toEqual(current);
    current = ['change_title', 'new_' + 'long_'.repeat(15)];
    const next = (await resolve({ serverName: 'happier', toolNameMaxLength: 40 }))!;
    expect(next.tools.map(tool => tool.originalName)).toEqual(current);
    expect(next.tools[1]!.projectedName).not.toBe(first.tools[1]!.projectedName);
    await expect(resolve({ serverName: 'custom', toolNameMaxLength: 40 })).resolves.toBeNull();
    const abort = new AbortController(); abort.abort();
    await expect(resolve({ serverName: 'happier', toolNameMaxLength: 40 }, { signal: abort.signal })).rejects.toBeDefined();
  });

  it('keeps default names and projects a stable distinct portable name within the requested model budget', () => {
    const originals = ['change_title', 'action_spec_search', 'plugin_' + 'long_tool_'.repeat(10), 'file.read', 'file_read', '日本語工具', 'h__reserved'];
    expect(projectMcpToolNames(originals).map(tool => tool.projectedName)).toEqual(originals);
    const projected = projectMcpToolNames(originals, 40);
    expect(projected.map(tool => tool.originalName)).toEqual(originals);
    expect(projected.every(tool => tool.projectedName.length <= 40 && /^[A-Za-z0-9_-]+$/.test(tool.projectedName))).toBe(true);
    expect(new Set(projected.map(tool => tool.projectedName)).size).toBe(originals.length);
    expect(projected[0]!.projectedName).toBe('change_title');
    expect(projected[1]!.projectedName).toBe('action_spec_search');
    const refreshed = projectMcpToolNames([originals[2]!, 'new_' + 'long_'.repeat(16)], 40);
    expect(refreshed[0]!.projectedName).toBe(projected[2]!.projectedName);
    expect(refreshed[1]!.projectedName.length).toBeLessThanOrEqual(40);
  });
});
