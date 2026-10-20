import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol';
import { FileUriPreview } from '@/components/workspaces/files/file/FileUriPreview';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

type Preview = Readonly<{ key: string }> & (
    | Readonly<{ phase: 'loading' | 'failed' }>
    | Readonly<{ phase: 'ready'; bytes: Uint8Array; signal: AbortSignal }>
);

/** Binary transport stays with Sync; temporary sources belong to the shared preview owner. */
export function ArtifactBinaryBody(props: Readonly<{ artifactId: string; name: string; reference: ArtifactBlobReferenceV1;
    readBytes: (artifactId: string, reference: ArtifactBlobReferenceV1, signal?: AbortSignal) => Promise<Uint8Array>;
    /** Bytes opened by the parent view's completed finite Account operation. */
    initialBytes?: Uint8Array;
    onRetry?: () => void;
}>) {
    const { theme } = useUnistyles();
    const reference = props.reference;
    const key = `${props.artifactId}:${reference.blobId}:${reference.sha256}`;
    const previewable = resolveFileViewerKind({ path: props.name, mimeType: reference.mime }).previewable;
    const [preview, setPreview] = React.useState<Preview>({ key, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    const [downloading, setDownloading] = React.useState(false);
    const [downloadFailed, setDownloadFailed] = React.useState(false);
    const downloadController = React.useRef<AbortController | null>(null);
    const imagePreviewModal = React.useRef<string | null>(null);
    React.useEffect(() => {
        setDownloading(false); setDownloadFailed(false);
        return () => {
            downloadController.current?.abort();
            downloadController.current = null;
        };
    }, [key]);
    React.useEffect(() => {
        if (!previewable) return;
        const controller = new AbortController();
        setPreview({ key, phase: 'loading' });
        void (async () => {
            const bytes = props.initialBytes ?? await props.readBytes(props.artifactId, reference, controller.signal);
            controller.signal.throwIfAborted();
            setPreview({ key, phase: 'ready', bytes, signal: controller.signal });
        })().catch(() => {
            if (!controller.signal.aborted) setPreview({ key, phase: 'failed' });
        });
        return () => {
            controller.abort();
            if (imagePreviewModal.current) Modal.hide(imagePreviewModal.current);
            imagePreviewModal.current = null;
        };
    }, [props.artifactId, props.name, props.readBytes, props.initialBytes, reference.blobId, reference.mime, reference.sha256, reference.sizeBytes, previewable, key, attempt]);
    const ready = preview.key === key && preview.phase === 'ready' ? preview : null;
    const previewInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        enabled: previewable && ready !== null,
        source: ready ? { kind: 'bytes', bytes: ready.bytes, name: props.name } : { kind: 'uri', uri: '' },
        cacheScopeId: props.artifactId,
        cacheKey: key,
        mimeType: reference.mime,
        sizeBytes: reference.sizeBytes,
    }), [previewable, ready?.bytes, props.name, props.artifactId, key, reference.mime, reference.sizeBytes]);
    const filePreview = useFilePreviewSource(previewInput);
    const download = async () => {
        if (downloadController.current) return;
        const controller = new AbortController();
        downloadController.current = controller;
        setDownloading(true); setDownloadFailed(false);
        try {
            const bytes = ready?.bytes ?? await props.readBytes(props.artifactId, reference, controller.signal);
            controller.signal.throwIfAborted();
            await saveFileBytes({ bytes, fileName: props.name, mimeType: reference.mime, isCurrent: () => !controller.signal.aborted });
        } catch { if (!controller.signal.aborted) setDownloadFailed(true); }
        finally {
            if (downloadController.current === controller) downloadController.current = null;
            if (!controller.signal.aborted) setDownloading(false);
        }
    };
    const card = <View style={{ gap: theme.space.s8 }} testID="artifact:fileCard">
        <Icon name={reference.mime.startsWith('image/') ? 'image' : 'file'} size={24} color={theme.colors.text.secondary} />
        <Text>{props.name}</Text>
        <Text style={{ color: theme.colors.text.secondary }}>{`${reference.mime} · ${formatHappierDataBytes(reference.sizeBytes, { kind: 'storage' })}`}</Text>
    </View>;
    return <View style={{ gap: theme.space.s16 }} testID="artifact:binaryBody">
        {ready && filePreview.status === 'loaded' ? <FileUriPreview uri={filePreview.uri} mime={reference.mime} title={props.name} fallback={card}
            onOpenImage={() => {
                void import('@/components/sessions/attachments/preview/AttachmentImagePreviewModal').then(({ AttachmentImagePreviewModal }) => {
                    if (ready.signal.aborted) return;
                    if (imagePreviewModal.current) Modal.hide(imagePreviewModal.current);
                    imagePreviewModal.current = Modal.show({ component: AttachmentImagePreviewModal, props: { images: [{ kind: 'direct', uri: filePreview.uri, title: props.name }] } });
                }).catch(() => {
                    if (!ready.signal.aborted) setPreview({ key, phase: 'failed' });
                });
            }} />
            : previewable && preview.key === key && (preview.phase === 'failed' || filePreview.status === 'error') ? <SurfaceStateCard testID="artifact:previewFailed" kind="error"
                title={t('artifacts.error')}
                reason={filePreview.error === t('files.imagePreviewTooLarge') ? filePreview.error : t('artifacts.browser.loadFailedBody')}
                detail={filePreview.error ?? undefined}
                action={{ label: t('common.retry'), onPress: props.onRetry ?? (() => setAttempt(value => value + 1)) }} /> : card}
        <RoundButton testID="artifact:download" title={t('files.repositoryTree.actions.download')} size="small" display="secondary" loading={downloading} onPress={() => { void download(); }} />
        {downloadFailed ? <Text accessibilityRole="alert" testID="artifact:downloadFailed">{t('artifacts.browser.loadFailedBody')}</Text> : null}
    </View>;
}
