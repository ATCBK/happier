import { describe, expect, it } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { useWorkspaceMarkdownImages } from './useWorkspaceMarkdownImages';

describe('workspace Markdown image consent wiring', () => {
    it('writes only on explicit Load, persists by workspace/file, and preserves another document choice', async () => {
        const state = getStorage().getState();
        const previous = state.localSettings.remoteImageConsentV1;
        state.applyLocalSettings({ remoteImageConsentV1: [] }, { source: 'ui' });
        const scope = { serverId: 'markdown-home', machineId: 'markdown-machine', rootPath: '/work/repo' };
        const first = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
        const second = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'README.md' }));
        try {
            expect(first.getCurrent().images.remoteLoaded).toBe(false);
            expect(getStorage().getState().localSettings.remoteImageConsentV1).toEqual([]);
            expect(first.getCurrent().images.resolve('./shot.png')).toEqual({ kind: 'workspace', path: 'docs/shot.png' });
            await act(async () => { first.getCurrent().images.onLoadRemote(); });
            expect(first.getCurrent().images.remoteLoaded).toBe(true);
            expect(second.getCurrent().images.remoteLoaded).toBe(false);
            await act(async () => { second.getCurrent().images.onLoadRemote(); });
            expect(loadLocalSettings().remoteImageConsentV1).toHaveLength(2);
            const reopened = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
            try { expect(reopened.getCurrent().images.remoteLoaded).toBe(true); }
            finally { await reopened.unmount(); }
            const otherWorkspace = await renderHook(() => useWorkspaceMarkdownImages({ scope: { ...scope, rootPath: '/other/repo' }, filePath: 'docs/README.md' }));
            try { expect(otherWorkspace.getCurrent().images.remoteLoaded).toBe(false); }
            finally { await otherWorkspace.unmount(); }
        } finally {
            await first.unmount();
            await second.unmount();
            getStorage().getState().applyLocalSettings({ remoteImageConsentV1: previous }, { source: 'ui' });
        }
    });
});
