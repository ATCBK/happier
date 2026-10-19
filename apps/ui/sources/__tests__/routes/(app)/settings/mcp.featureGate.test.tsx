import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks } from './sessionSettingsEntryTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureEnabledMock = vi.fn(() => true);

vi.mock('@/components/settings/shell/SettingsCollectionLayout', () => ({
    SettingsCollectionLayout: (props: Record<string, unknown>) => React.createElement('SettingsCollectionLayout', props),
}));

installSessionSettingsEntryModuleMocks();

describe('MCP settings route (feature gate)', () => {
    beforeEach(() => {
        useFeatureEnabledMock.mockClear();
    });

    it('returns null when mcp.servers feature is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);

        const mod = await import('@/app/(app)/settings/mcp/_layout');
        const McpRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(McpRoute))).tree;

        expect(tree.toJSON()).toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalled();
    });

    it('renders the MCP collection when mcp.servers feature is enabled', async () => {
        useFeatureEnabledMock.mockReturnValue(true);

        const mod = await import('@/app/(app)/settings/mcp/_layout');
        const McpRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(McpRoute))).tree;

        expect(tree.toJSON()).not.toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalled();
        const layout = tree.root.findByType('SettingsCollectionLayout' as any);
        expect(layout.props.navigator).toBe('mcp');
        expect(layout.props.rootPathname).toBe('/settings/mcp');
    });
});
