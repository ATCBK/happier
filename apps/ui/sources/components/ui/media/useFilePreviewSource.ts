import * as React from 'react';
import type { ComposerContentHandleV1, SessionAttachmentHandleV1 } from '@happier-dev/protocol';

import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    createBytesPreviewSource,
    createComposerStagedMediaPreviewSource,
    createSessionFilePreviewSource,
    createSessionAttachmentPreviewSource,
    PREVIEW_TOO_LARGE_ERROR,
    type SessionFilePreviewSource,
} from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';
import { ImagePreviewCache, type ImagePreviewCacheValue } from './imagePreviewCache';
import { buildWorkspacePreviewIdentity } from './buildWorkspacePreviewIdentity';

export type FilePreviewSource =
    | Readonly<{ kind: 'workspace'; scope: WorkspaceScopeBase; filePath: string }>
    | Readonly<{ kind: 'session'; sessionId: string; filePath: string }>
    | Readonly<{ kind: 'attachment'; handle: SessionAttachmentHandleV1; fileName: string }>
    | Readonly<{ kind: 'composerStage'; handle: ComposerContentHandleV1 }>
    | Readonly<{ kind: 'bytes'; bytes: Uint8Array; name: string }>
    | Readonly<{ kind: 'uri'; uri: string }>;

export type UseFilePreviewSourceInput = Readonly<{
    enabled: boolean;
    source: FilePreviewSource;
    cacheKey?: string | null;
    cacheScopeId?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    maxBytes?: number | null;
}>;
export type FilePreviewSourceState =
    | Readonly<{ status: 'disabled' | 'loading'; uri: null; error: null }>
    | Readonly<{ status: 'loaded'; uri: string; error: null; byteLength?: number; mimeType?: string }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

const imagePreviewCache = new ImagePreviewCache({
    maxEntries: 32,
    maxTotalBytes: 96 * 1024 * 1024,
    now: () => Date.now(),
});

function cleanupPreviewSource(source: SessionFilePreviewSource): () => void | Promise<void> {
    return source.kind === 'object-url' ? source.revoke : source.delete;
}

function previewState(value: ImagePreviewCacheValue): FilePreviewSourceState {
    if (value.status === 'error') return { status: 'error', uri: null, error: value.error };
    return { status: 'loaded', uri: value.uri, error: null,
        ...(typeof value.byteLength === 'number' ? { byteLength: value.byteLength } : {}),
        ...(value.mimeType ? { mimeType: value.mimeType } : {}) };
}

export function useFilePreviewSource(input: UseFilePreviewSourceInput): FilePreviewSourceState {
    const source = input.source;
    const enabled = input.enabled === true;
    const kind = source.kind;
    const sessionScope = useSessionWorkspaceTarget(enabled && source.kind === 'session' ? source.sessionId : null);
    const rawScope = source.kind === 'workspace' ? source.scope : source.kind === 'session' ? sessionScope : null;
    const scope = React.useMemo<WorkspaceScopeBase | null>(() => rawScope
        ? { serverId: rawScope.serverId, machineId: rawScope.machineId, rootPath: rawScope.rootPath } : null,
    [rawScope?.serverId, rawScope?.machineId, rawScope?.rootPath]);
    const stage = source.kind === 'composerStage' ? source.handle : null;
    const attachment = source.kind === 'attachment' ? source.handle : null;
    const bytes = source.kind === 'bytes' ? source.bytes : null;
    const directUri = source.kind === 'uri' ? source.uri : null;
    const filePath = source.kind === 'workspace' || source.kind === 'session' ? source.filePath
        : source.kind === 'attachment' ? source.fileName
        : source.kind === 'composerStage' ? source.handle.name
        : source.kind === 'bytes' ? source.name : source.uri;
    const sizeBytes = stage?.sizeBytes ?? bytes?.byteLength ?? input.sizeBytes ?? null;
    const viewer = resolveFileViewerKind({ path: filePath, mimeType: stage?.mimeType ?? input.mimeType });
    const mimeType = viewer.mimeType;
    const cacheMaxEntries = useSetting('filesImagePreviewCacheMaxEntries');
    const cacheMaxTotalBytes = useSetting('filesImagePreviewCacheMaxTotalBytes');
    const previewLimit = useSetting('filesImagePreviewMaxBytes');
    const maxBytes = input.maxBytes !== undefined ? input.maxBytes : viewer.kind === 'video' ? null : previewLimit;
    const normalizedMaxBytes = maxBytes === null ? null : typeof maxBytes === 'number' && Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0;
    const cacheKey = (input.cacheKey ?? stage?.sha256)?.trim() || null;
    const cacheScopeId = input.cacheScopeId?.trim() || (attachment
        ? JSON.stringify(['session-attachment', attachment.sessionId, attachment.id])
        : stage ? JSON.stringify(['composer-stage', stage.executionTarget.serverId, stage.executionTarget.machineId, stage.owner.pluginId, stage.owner.localId, stage.id])
        : scope ? buildWorkspacePreviewIdentity(scope, filePath, sizeBytes, null).cacheScopeId
        : source.kind === 'session' ? source.sessionId : source.kind === 'bytes' ? 'bytes' : '');
    const stageIdentity = stage ? JSON.stringify(stage) : null;
    const attachmentIdentity = attachment ? JSON.stringify(attachment) : null;
    const identity = JSON.stringify([kind, cacheScopeId, cacheKey, filePath, mimeType, sizeBytes, normalizedMaxBytes, stageIdentity, attachmentIdentity]);
    const [resource, setResource] = React.useState<Readonly<{ identity: string; bytes: Uint8Array | null; state: FilePreviewSourceState }> | null>(null);
    const sourceRef = React.useRef(source);
    sourceRef.current = source;

    React.useEffect(() => {
        imagePreviewCache.setLimits({
            maxEntries: typeof cacheMaxEntries === 'number' && Number.isFinite(cacheMaxEntries) ? Math.max(0, cacheMaxEntries) : 0,
            maxTotalBytes: typeof cacheMaxTotalBytes === 'number' && Number.isFinite(cacheMaxTotalBytes) ? Math.max(0, cacheMaxTotalBytes) : 0,
        });
    }, [cacheMaxEntries, cacheMaxTotalBytes]);

    React.useEffect(() => {
        if (!enabled || kind === 'uri' || !viewer.previewable || ((kind === 'workspace' || kind === 'session') && !scope)) {
            setResource(null);
            return;
        }
        let active = true;
        const controller = new AbortController();
        const key = cacheKey ? { sessionId: cacheScopeId, signature: cacheKey, filePath } : null;
        let uncached: ImagePreviewCacheValue | null = null;
        const publish = (value: ImagePreviewCacheValue) => {
            if (active) setResource({ identity, bytes, state: previewState(value) });
        };
        const load = async (signal: AbortSignal): Promise<ImagePreviewCacheValue> => {
            const current = sourceRef.current;
            try {
                const result = current.kind === 'composerStage'
                    ? await createComposerStagedMediaPreviewSource({ handle: current.handle, maxBytes: normalizedMaxBytes, signal })
                    : current.kind === 'attachment'
                    ? await createSessionAttachmentPreviewSource({ handle: current.handle, fileName: filePath, mimeType, maxBytes: normalizedMaxBytes, expectedSizeBytes: sizeBytes, signal })
                    : current.kind === 'bytes'
                    ? await createBytesPreviewSource({ bytes: current.bytes, fileName: filePath, mimeType, maxBytes: normalizedMaxBytes, signal })
                    : await createSessionFilePreviewSource({ scope: scope!, filePath, mimeType, maxBytes: normalizedMaxBytes, expectedSizeBytes: sizeBytes, signal });
                if (!result.ok) return { status: 'error', error: result.error === PREVIEW_TOO_LARGE_ERROR ? t('files.imagePreviewTooLarge') : result.error || t('files.fileReadFailed') };
                return { status: 'loaded', uri: result.source.uri, byteLength: result.source.byteLength, mimeType: result.source.mimeType, cleanup: cleanupPreviewSource(result.source) };
            } catch (error) {
                return { status: 'error', error: error instanceof Error ? error.message : t('files.fileReadFailed') };
            }
        };
        if (key) imagePreviewCache.retain(key);
        const tooLarge = normalizedMaxBytes !== null && sizeBytes !== null && sizeBytes > normalizedMaxBytes;
        const pending = tooLarge ? Promise.resolve<ImagePreviewCacheValue>({ status: 'error', error: t('files.imagePreviewTooLarge') }) : key ? imagePreviewCache.load(key, load) : load(controller.signal).then(value => {
            uncached = value;
            if (!active && value.status === 'loaded') void Promise.resolve(value.cleanup?.()).catch(() => undefined);
            return value;
        });
        void pending.then(publish);
        return () => {
            active = false;
            controller.abort();
            if (key) imagePreviewCache.release(key);
            else if (uncached?.status === 'loaded') void Promise.resolve(uncached.cleanup?.()).catch(() => undefined);
        };
    }, [enabled, identity, kind, cacheScopeId, cacheKey, filePath, mimeType, sizeBytes, normalizedMaxBytes, scope, bytes, viewer.previewable]);

    if (!enabled) return { status: 'disabled', uri: null, error: null };
    if (directUri !== null) return { status: 'loaded', uri: directUri, error: null };
    if (!viewer.previewable) return { status: 'disabled', uri: null, error: null };
    return resource?.identity === identity && resource.bytes === bytes ? resource.state : { status: 'loading', uri: null, error: null };
}

