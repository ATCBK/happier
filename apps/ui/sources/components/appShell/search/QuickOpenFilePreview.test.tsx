import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
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
    it.each([
        ['manual', '%PDF-1.7\n'],
        ['payload.txt', 'before\0after'],
    ])('classifies read evidence for %s before choosing the text body', async (path, content) => {
        const scope = { serverId, machineId: 'm1', rootPath: '/preview-repo' };
        const render = (selectedPath: string) => <QuickOpenFilePreview scope={scope} path={selectedPath} />;
        const screen = await renderScreen(render('source.ts'));
        await expect.poll(() => screen.tree.findAllByType(FileContentPanel).map(node => node.props.fileContent)).toEqual(['export const a = 1;\n']);
        boundary.read.mockResolvedValue({ success: true, content: encodeBase64(new TextEncoder().encode(content)) });
        await screen.update(render(path));
        await expect.poll(() => screen.tree.findAllByType(FileContentPanel).length).toBe(0);
        expect(screen.tree.findAllByType(FileIcon).some(node => node.props.fileName === path)).toBe(true);
        boundary.read.mockResolvedValue({ success: true, content: encodeBase64(new TextEncoder().encode('plain text\n')) });
        await screen.update(render('valid.txt'));
        await expect.poll(() => screen.tree.findAllByType(FileContentPanel).map(node => node.props.fileContent)).toEqual(['plain text\n']);
    });

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
