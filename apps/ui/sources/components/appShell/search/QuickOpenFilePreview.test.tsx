import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    installWorkspaceFileDetailsActionBoundary, installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary, cleanupWorkspaceFileDetailsActionBoundary, getWorkspaceFileDetailsActionBoundary,
} from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileDetailsTestHelpers';

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Cold module preparation belongs to collection, outside the Account lifecycle hook.
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { QuickOpenFilePreview } = await import('./QuickOpenFilePreview');
const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');
const { FileIcon } = await import('@/components/ui/media/FileIcon');
const boundary = getWorkspaceFileDetailsActionBoundary();
let serverId: string;
beforeEach(async () => {
    serverId = await prepareWorkspaceFileDetailsActionBoundary();
    boundary.read.mockReset().mockResolvedValue({ success: true, content: 'ZXhwb3J0IGNvbnN0IGEgPSAxOwo=' });
});
afterEach(async () => { await standardCleanup(); await cleanupWorkspaceFileDetailsActionBoundary(); });

describe('QuickOpenFilePreview', () => {
    it('uses the selected media identity without decoding it as text or retaining another file body', async () => {
        const scope = { serverId, machineId: 'm1', rootPath: '/preview-repo' };
        const render = (path: string) => <QuickOpenFilePreview scope={scope} path={path} />;
        const screen = await renderScreen(render('source.ts'));
        await expect.poll(() => screen.tree.findAllByType(FileContentPanel).map(node => node.props.fileContent)).toEqual(['export const a = 1;\n']);
        boundary.read.mockClear();
        for (const path of ['picture.png', 'drawing.svg', 'paper.pdf', 'recording.mp4', 'voice.mp3', 'archive.zip']) {
            await screen.update(render(path));
            await flushHookEffects();
            expect(screen.tree.findAllByType(FileContentPanel)).toHaveLength(0);
            expect(screen.tree.findAllByType(FileIcon).some(node => node.props.fileName === path)).toBe(true);
        }
        expect(boundary.read).not.toHaveBeenCalled();
    });
});
