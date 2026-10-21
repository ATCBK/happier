import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, renderSessionSettingsEntryView } from './sessionSettingsEntryTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/settings/shell/SettingsCollectionLayout', () => ({
    SettingsCollectionLayout: (props: Record<string, unknown>) => React.createElement('SettingsCollectionLayout', props),
}));

installSessionSettingsEntryModuleMocks();

describe('MCP settings route', () => {
    afterEach(standardCleanup);

    // The route is no longer behind an `mcp.servers` feature bit (removed in 947ac8f1cd).
    it('renders the MCP collection without any server feature gate', async () => {
        const mod = await import('@/app/(app)/settings/mcp/_layout');
        const McpRoute = mod.default;

        const { tree } = await renderSessionSettingsEntryView(React.createElement(McpRoute));

        expect(tree.toJSON()).not.toBeNull();
        const layout = tree.root.findByType('SettingsCollectionLayout' as any);
        expect(layout.props.navigator).toBe('mcp');
        expect(layout.props.rootPathname).toBe('/settings/mcp');
    });
});
