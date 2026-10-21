import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { RepositoryTreeRowActionMenuItemId } from './RepositoryTreeRowActionsMenu';
import type { FileMenuContext } from '@/components/workspaces/files/file/fileMenus';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
// Only portal placement/window measurement is substituted; menu rows and selection stay real.
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

describe('canonical repository row menu', () => {
    async function render(input: { kind: 'file' | 'directory'; downloadActionsEnabled: boolean; disableWriteActions?: boolean; fileMenuContext?: FileMenuContext;
        share?: import('./RepositoryTreeRowActionsMenu').RepositoryTreeRowShareTarget }) {
        const { RepositoryTreeRowActionsMenu } = await import('./RepositoryTreeRowActionsMenu');
        const selected: RepositoryTreeRowActionMenuItemId[] = [];
        const screen = await renderScreen(<RepositoryTreeRowActionsMenu path="folder.ts" kind={input.kind}
            downloadActionsEnabled={input.downloadActionsEnabled} disableWriteActions={input.disableWriteActions ?? false}
            fileMenuContext={input.fileMenuContext} share={input.share}
            control={{ open: true, onOpenChange: () => {}, triggerHidden: true }} onSelect={item => selected.push(item)} />);
        return { screen, selected };
    }

    it('consumes shared file-menu callbacks once and preserves canonical offline admission', async () => {
        const copyLink = vi.fn();
        const discardAll = vi.fn();
        const context: FileMenuContext = { machineReachable: false, unavailableReason: 'offline', hasCachedContent: false,
            platform: 'ios', copyLink, changes: { discardAll } };
        const { screen } = await render({ kind: 'file', downloadActionsEnabled: false, fileMenuContext: context });
        expect(screen.findByTestId('repository-tree-menuitem-copyLink')).toBeTruthy();
        expect(screen.findByTestId('repository-tree-menuitem-discard')).toBeTruthy();
        expect(screen.findByTestId('repository-tree-menuitem-discard')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('repository-tree-menuitem-copyLink');
        expect(copyLink).toHaveBeenCalledOnce();
        expect(discardAll).not.toHaveBeenCalled();
    });

    it('offers file and directory downloads by actual entry kind and dispatches the selected action', async () => {
        const file = await render({ kind: 'file', downloadActionsEnabled: true });
        expect(file.screen.findByTestId('repository-tree-menuitem-download')).toBeTruthy();
        expect(file.screen.findByTestId('repository-tree-menuitem-zip')).toBeTruthy();
        await file.screen.pressByTestIdAsync('repository-tree-menuitem-download');
        await vi.waitFor(() => expect(file.selected).toEqual(['repository-tree-menuitem-download']));
        const directory = await render({ kind: 'directory', downloadActionsEnabled: true });
        expect(directory.screen.findByTestId('repository-tree-menuitem-download')).toBeNull();
        expect(directory.screen.findByTestId('repository-tree-menuitem-zip')).toBeTruthy();
    });

    it('omits unavailable transfer actions while keeping disabled writes and local Copy path truthful', async () => {
        const { screen, selected } = await render({ kind: 'file', downloadActionsEnabled: false, disableWriteActions: true });
        expect(screen.findByTestId('repository-tree-menuitem-download')).toBeNull();
        expect(screen.findByTestId('repository-tree-menuitem-zip')).toBeNull();
        expect(screen.findByTestId('repository-tree-menuitem-rename')?.props.disabled).toBe(true);
        expect(screen.findByTestId('repository-tree-menuitem-delete')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('repository-tree-menuitem-copy-path');
        await vi.waitFor(() => expect(selected).toEqual(['repository-tree-menuitem-copy-path']));
    });

    it('keeps Mention available for files and folders while link sharing requires a destination', async () => {
        const workspaceScope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' };
        const share = { workspaceScope, actionScope: { serverId: 'home-a', accountId: 'account-a' },
            linkTarget: { kind: 'session' as const, sessionId: 'session-a', serverId: 'home-a' },
            composer: { scope: { serverId: 'home-a', accountId: 'account-a' }, ref: { kind: 'session' as const, sessionId: 'session-a' }, workspace: workspaceScope } };
        const file = await render({ kind: 'file', downloadActionsEnabled: false, share });
        expect(file.screen.findByTestId('repository-tree-menuitem-copyLink')).toBeTruthy();
        expect(file.screen.findByTestId('repository-tree-menuitem-mentionInComposer')).toBeTruthy();
        const noTargets = await render({ kind: 'file', downloadActionsEnabled: false, share: { workspaceScope, actionScope: share.actionScope } });
        expect(noTargets.screen.findByTestId('repository-tree-menuitem-copyLink')).toBeNull();
        expect(noTargets.screen.findByTestId('repository-tree-menuitem-mentionInComposer')).toBeTruthy();
        const folder = await render({ kind: 'directory', downloadActionsEnabled: false, share });
        expect(folder.screen.findByTestId('repository-tree-menuitem-copyLink')).toBeNull();
        expect(folder.screen.findByTestId('repository-tree-menuitem-mentionInComposer')).toBeTruthy();
    });
});
