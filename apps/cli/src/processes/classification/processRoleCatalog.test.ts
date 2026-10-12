import { describe, expect, it } from 'vitest';
import { GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol/installables';
import { projectProcessRoleCatalog } from './processRoleCatalog';
import { classifyProcessRole } from './classifyProcessRole';

describe('process role catalog projection', () => {
    it('uses canonical installable command metadata to identify configured MCP processes', () => {
        const catalog = projectProcessRoleCatalog({ catalogEntriesById: {}, agentDefinitionsById: new Map(),
            systemToolsById: new Map(), managedDependenciesByKey: new Map([['acme.tools/gh', {
                pluginId: 'acme.tools', provenance: 'external', source: { kind: 'path' }, definition: GH_INSTALLABLE_DESCRIPTOR,
            }]]), mcpServers: [{ pluginId: 'acme.tools', provenance: 'external', source: { kind: 'path' },
                definition: { id: 'repo-mcp', title: 'Repo MCP', kind: 'static',
                    transport: { kind: 'stdio', executable: { kind: 'managedDependency', id: 'gh' } } } }] });
        expect(classifyProcessRole({ command: '/managed/bin/gh --mcp', ...catalog })).toMatchObject({ role: 'mcp_server', displayName: 'repo-mcp' });
    });
    it('preserves browser helper evidence and a redacted driver while classifying actual shell and test commands', () => {
        expect(classifyProcessRole({ command: '/bin/bash -lc build' }).role).toBe('tool_shell');
        expect(classifyProcessRole({ command: 'vitest run' }).role).toBe('test_runner');
        const browser = classifyProcessRole({ command: 'chromium --type=renderer', ancestors: [{ command: 'playwright --token=secret' }] });
        expect(browser).toMatchObject({ role: 'browser', browserEngine: 'chromium', browserHelper: true });
        expect(browser.driverLabel).not.toContain('secret');
    });
});
