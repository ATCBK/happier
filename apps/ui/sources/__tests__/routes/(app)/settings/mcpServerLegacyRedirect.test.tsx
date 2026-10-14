import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerState = vi.hoisted(() => ({ params: {} as Record<string, string> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    return { ...mock.module, useLocalSearchParams: () => routerState.params };
});

async function redirectTargetFor(params: Record<string, string>): Promise<unknown> {
    routerState.params = params;
    const Route = (await import('@/app/(app)/settings/mcp-server')).default;
    const screen = await renderScreen(<Route />);
    return screen.tree.root.findByType('Redirect' as never).props.href;
}

describe('legacy MCP server editor links', () => {
    it('open the same server inside the MCP collection', async () => {
        expect(await redirectTargetFor({ serverId: 'server-1' })).toBe('/settings/mcp/server-1');
    });

    it('open the matching Add mode, or the custom draft', async () => {
        expect(await redirectTargetFor({ addMode: 'quick-install', presetId: 'github' })).toBe('/settings/mcp?add=catalog');
        expect(await redirectTargetFor({ addMode: 'import-json' })).toBe('/settings/mcp?add=paste');
        expect(await redirectTargetFor({})).toBe('/settings/mcp/new');
    });
});
