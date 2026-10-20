import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storageStore';
import { addRemoteImageConsent, hasRemoteImageConsent } from '@/sync/domains/settings/remoteImageConsent';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { resolveWorkspaceFileReference, resolveWorkspaceMarkdownImage } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import type { MarkdownImageResolver } from './markdownImages';

/** The File page and README share this explicit document context and device-local consent owner. */
export function useWorkspaceMarkdownImages(input: Readonly<{ scope: WorkspaceScopeBase; filePath: string }>): Readonly<{
    images: MarkdownImageResolver;
    imageScope: WorkspaceScopeBase;
}> {
    const { serverId, machineId, rootPath } = input.scope;
    const imageScope = React.useMemo(() => ({ serverId, machineId, rootPath }), [serverId, machineId, rootPath]);
    const workspaceCacheKey = React.useMemo(() => tryBuildWorkspaceCacheKey(imageScope), [imageScope]);
    const filePath = React.useMemo(() => resolveWorkspaceFileReference({ url: input.filePath, workspacePath: rootPath })?.filePath ?? null,
        [input.filePath, rootPath]);
    const identityPath = React.useMemo(() => filePath
        ? resolvePathRelativeToRoot({ path: `${rootPath.replace(/[\\/]+$/, '')}/${filePath}`, root: rootPath })
        : null, [filePath, rootPath]);
    const remoteLoaded = getStorage()(state => Boolean(workspaceCacheKey && identityPath
        && hasRemoteImageConsent(state.localSettings.remoteImageConsentV1, workspaceCacheKey, identityPath)));
    const onLoadRemote = React.useCallback(() => {
        if (!workspaceCacheKey || !identityPath) return;
        const state = getStorage().getState();
        const next = addRemoteImageConsent(state.localSettings.remoteImageConsentV1, workspaceCacheKey, identityPath);
        if (next !== state.localSettings.remoteImageConsentV1) {
            state.applyLocalSettings({ remoteImageConsentV1: next.map(([workspace, file]): [string, string] => [workspace, file]) }, { source: 'ui' });
        }
    }, [workspaceCacheKey, identityPath]);
    const resolve = React.useCallback<MarkdownImageResolver['resolve']>(destination => filePath
        ? resolveWorkspaceMarkdownImage({ destination, workspacePath: rootPath, sourceFilePath: filePath })
        : { kind: 'blocked' }, [filePath, rootPath]);
    const images = React.useMemo(() => ({ resolve, remoteLoaded, onLoadRemote }), [resolve, remoteLoaded, onLoadRemote]);
    return React.useMemo(() => ({ images, imageScope }), [images, imageScope]);
}
