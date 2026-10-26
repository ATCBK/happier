import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks();
afterEach(async () => { vi.unstubAllGlobals(); await standardCleanup(); });

it('splits the header actions\' 6 px gap between neighbours, so no two finger frames overlap', async () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { ProjectShellHeader } = await import('./ProjectShellHeader');
    const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null} pages={[]}
        activePage="overview" onSelectPage={() => {}} onNewSession={() => {}}
        menuActions={[{ id: 'rename', title: 'Rename', onSelect: () => {} }]} />);
    // A band narrower than the wide threshold draws the compact icon actions, the ones with a side reach.
    await act(async () => screen.findHostByTestId('project-shell-header')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 56 } } }));
    const sideReach = async (testID: string, size: Readonly<{ width: number; height: number }>) => {
        const host = screen.findHostByTestId(testID)!;
        await act(async () => host.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...size } } }));
        const frame = screen.findHostByTestId(testID)!.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0]!;
        return { left: -frame.props.style.left, right: -frame.props.style.right };
    };
    const gapHalf = 3;
    expect(await sideReach('project-shell-header.newSession', { width: 32, height: 32 })).toEqual({ left: gapHalf, right: gapHalf });
    expect(await sideReach('project-shell-header.menu.trigger', { width: 32, height: 32 })).toEqual({ left: gapHalf, right: gapHalf });
});
