import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { HappierStoredImage, type HappierStoredImageHost } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { useFilePreviewSource } from '@/components/ui/media/useFilePreviewSource';
import { Icon } from '@/components/ui/icons/Icon';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import {
    resolveSessionMediaInlineImageLayout,
} from '@/components/sessions/media/resolveSessionMediaInlineImageLayout';
import { SessionMediaVideoPreview } from '@/components/sessions/media/SessionMediaVideoPreview';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type {
    SessionMediaInlineImageAvailableSummary,
    SessionMediaInlineMediaSummary,
    SessionMediaInlineImageSummary,
    SessionMediaInlineImageUnavailableSummary,
    SessionMediaInlineVideoAvailableSummary,
} from '@/sync/domains/session/media/sessionMediaMessageMeta';

type SessionMediaInlineRenderableSummary =
    | SessionMediaInlineImageSummary
    | SessionMediaInlineMediaSummary;

const inlineImageFillStyle = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
} as const;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: theme.space.s2,
        marginBottom: theme.space.s6,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    tile: {
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
    unavailableText: {
        marginTop: theme.space.s6,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    videoLabel: {
        marginTop: theme.space.s6,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        paddingHorizontal: theme.space.s8,
    },
}));

function isUnavailableInlineImage(
    media: SessionMediaInlineRenderableSummary,
): media is SessionMediaInlineImageUnavailableSummary {
    return media.status === 'unavailable';
}

function isInlineVideo(
    media: SessionMediaInlineRenderableSummary,
): media is SessionMediaInlineVideoAvailableSummary {
    return 'mediaKind' in media && media.mediaKind === 'video';
}

function resolveInlineImageAccessibilityLabel(media: SessionMediaInlineImageSummary): string {
    if (media.category === 'attachment') {
        return t('files.sessionMedia.attachmentImageA11y', { name: media.name });
    }
    if (media.category === 'tool-artifact') {
        return t('files.sessionMedia.toolArtifactImageA11y', { name: media.name });
    }
    return t('files.sessionMedia.generatedImageA11y', { name: media.name });
}

function resolveInlineVideoAccessibilityLabel(media: SessionMediaInlineVideoAvailableSummary): string {
    if (media.category === 'attachment') {
        return t('files.sessionMedia.attachmentVideoA11y', { name: media.name });
    }
    if (media.category === 'tool-artifact') {
        return t('files.sessionMedia.toolArtifactVideoA11y', { name: media.name });
    }
    return t('files.sessionMedia.generatedVideoA11y', { name: media.name });
}

function SessionMediaInlineVideoTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineVideoAvailableSummary;
    testIdPrefix: string;
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const preview = useFilePreviewSource({
        source: props.media.attachmentHandle
            ? { kind: 'attachment', handle: props.media.attachmentHandle, fileName: props.media.path }
            : { kind: 'session', sessionId: props.sessionId, filePath: props.media.path },
        enabled: true,
        cacheKey: props.media.sha256 ?? null,
        mimeType: props.media.mimeType,
        sizeBytes: props.media.sizeBytes,
    });
    const accessibilityLabel = resolveInlineVideoAccessibilityLabel(props.media);

    return (
        <Pressable
            testID={`${props.testIdPrefix}-inline-video:${props.media.path}`}
            accessibilityRole={props.fileOpenEnabled ? 'button' : 'image'}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={preview.status === 'error'
                ? t('files.sessionMedia.previewUnavailableA11y')
                : undefined}
            onPress={props.fileOpenEnabled ? () => props.onOpenPath(props.media.path) : undefined}
            style={[styles.tile, { width: 168, height: 104 }]}
        >
            {preview.status === 'loaded' ? (
                <SessionMediaVideoPreview
                    uri={preview.uri}
                    accessibilityLabel={accessibilityLabel}
                />
            ) : (
                <View style={styles.placeholder}>
                    <Icon
                        name={preview.status === 'error' ? 'warning-circle' : 'video-camera'}
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                    <Text style={styles.videoLabel} numberOfLines={2}>
                        {props.media.name}
                    </Text>
                </View>
            )}
        </Pressable>
    );
}

function SessionMediaInlineImageTile(props: Readonly<{
    sessionId: string;
    workspaceScope?: WorkspaceScopeBase | null;
    media: SessionMediaInlineImageAvailableSummary;
    imageIndex: number;
    testIdPrefix: string;
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    onOpenPreview: (index: number) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    const preview = useFilePreviewSource({
        source: props.media.attachmentHandle
            ? { kind: 'attachment', handle: props.media.attachmentHandle, fileName: props.media.path }
            : props.workspaceScope
                ? { kind: 'workspace', scope: props.workspaceScope, filePath: props.media.path }
                : { kind: 'session', sessionId: props.sessionId, filePath: props.media.path },
        enabled: true,
        cacheKey: props.media.sha256 ?? null,
        mimeType: props.media.mimeType,
        sizeBytes: props.media.sizeBytes,
    });
    const actionable = preview.status !== 'error' || props.fileOpenEnabled;

    return (
        <HappierStoredImage
            identity={JSON.stringify([props.media.path, props.media.sha256])}
            status={preview.status}
            uri={preview.uri}
            dimensions={props.media}
            host={SESSION_STORED_IMAGE_HOST}
            borderColor={theme.colors.border.default}
            backgroundColor={theme.colors.surface.elevated}
            imageTestID={`${props.testIdPrefix}-inline-image-preview:${props.media.path}`}
            testID={`${props.testIdPrefix}-inline-image:${props.media.path}`}
            accessibilityLabel={resolveInlineImageAccessibilityLabel(props.media)}
            accessibilityHint={preview.status === 'error'
                ? t('files.sessionMedia.previewUnavailableA11y')
                : undefined}
            onPress={actionable
                ? () => {
                    if (preview.status === 'error') {
                        props.onOpenPath(props.media.path);
                        return;
                    }
                    props.onOpenPreview(props.imageIndex);
                }
                : undefined}
            placeholder={(
                    <Icon
                        name={preview.status === 'error' ? 'warning-circle' : 'image'}
                        size={20}
                        color={theme.colors.text.secondary}
                    />
            )}
        />
    );
}

export const SESSION_STORED_IMAGE_HOST: HappierStoredImageHost = Object.freeze({
    renderImage: ({ uri, testID, onLoad }) => <Image testID={testID} source={{ uri }} contentFit="contain"
        onLoad={(event) => onLoad(event.source)} style={inlineImageFillStyle} />,
} satisfies HappierStoredImageHost);

function SessionMediaInlineInertTile(props: Readonly<{
    media: SessionMediaInlineImageAvailableSummary | SessionMediaInlineVideoAvailableSummary;
    testIdPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const video = isInlineVideo(props.media);
    const size = video
        ? { width: 168, height: 104 }
        : resolveSessionMediaInlineImageLayout({
            persistedDimensions: props.media,
            loadedDimensions: null,
        });

    return (
        <View
            testID={`${props.testIdPrefix}-inline-${video ? 'video' : 'image'}:${props.media.path}`}
            accessibilityRole="image"
            accessibilityLabel={video
                ? resolveInlineVideoAccessibilityLabel(props.media)
                : resolveInlineImageAccessibilityLabel(props.media)}
            style={[styles.tile, size]}
        >
            <View style={styles.placeholder}>
                <Icon
                    name={video ? 'video-camera' : 'image'}
                    size={video ? 24 : 22}
                    color={theme.colors.text.secondary}
                />
                {video ? (
                    <Text style={styles.videoLabel} numberOfLines={2}>
                        {props.media.name}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

function SessionMediaUnavailableInlineImageTile(props: Readonly<{
    media: SessionMediaInlineImageUnavailableSummary;
    testIdPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View
            testID={`${props.testIdPrefix}-inline-image-unavailable:${props.media.id}`}
            accessibilityRole="image"
            accessibilityLabel={t('files.sessionMedia.unavailableImageA11y', { name: props.media.name })}
            style={[styles.tile, styles.placeholder, { width: 84, height: 84 }]}
        >
            <Icon
                name="warning-circle"
                size={20}
                color={theme.colors.text.secondary}
            />
            <Text style={styles.unavailableText} numberOfLines={2}>
                {t('files.sessionMedia.previewUnavailableA11y')}
            </Text>
        </View>
    );
}

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: Readonly<{
    sessionId: string;
    /**
     * Where the files live when it is not the Session's working directory (media the daemon stored
     * under its own home for this Session). Omitted, the Session's workspace is the root.
     */
    workspaceScope?: WorkspaceScopeBase | null;
    media: readonly SessionMediaInlineRenderableSummary[];
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    mediaPreviewEnabled: boolean;
    testIdPrefix?: string;
}>) {
    const styles = stylesheet;
    const testIdPrefix = props.testIdPrefix ?? 'message-session-media';

    const images = React.useMemo(() => {
        let nextModalIndex = 0;
        return props.media.map((media): Readonly<{
            media: SessionMediaInlineRenderableSummary;
            modalImage: AttachmentImagePreviewModalImage | null;
            modalIndex: number | null;
        }> => {
            if (isUnavailableInlineImage(media) || isInlineVideo(media)) {
                return {
                    media,
                    modalImage: null,
                    modalIndex: null,
                };
            }

            const modalIndex = nextModalIndex;
            nextModalIndex += 1;
            return {
                media,
                modalImage: {
                    kind: 'session-image',
                    title: media.name,
                    sessionId: props.sessionId,
                    filePath: media.path,
                    mimeType: media.mimeType,
                    sizeBytes: media.sizeBytes,
                    cacheKey: media.sha256 ?? null,
                    attachmentHandle: media.attachmentHandle,
                    workspaceScope: props.workspaceScope ?? null,
                },
                modalIndex,
            };
        });
    }, [props.media, props.sessionId, props.workspaceScope]);

    if (images.length === 0) return null;

    return (
        <View testID={`${testIdPrefix}-inline-images`} style={styles.container}>
            {images.map((entry, index) => (
                isUnavailableInlineImage(entry.media) ? (
                    <SessionMediaUnavailableInlineImageTile
                        key={entry.media.id}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                    />
                ) : !props.mediaPreviewEnabled ? (
                    <SessionMediaInlineInertTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                    />
                ) : isInlineVideo(entry.media) ? (
                    <SessionMediaInlineVideoTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        sessionId={props.sessionId}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                        onOpenPath={props.onOpenPath}
                        fileOpenEnabled={props.fileOpenEnabled}
                    />
                ) : (
                    <SessionMediaInlineImageTile
                        workspaceScope={props.workspaceScope}
                        key={`${entry.media.id}:${entry.media.path}`}
                        sessionId={props.sessionId}
                        media={entry.media}
                        imageIndex={entry.modalIndex ?? 0}
                        testIdPrefix={testIdPrefix}
                        onOpenPath={props.onOpenPath}
                        fileOpenEnabled={props.fileOpenEnabled}
                        onOpenPreview={(imageIndex) => {
                            const modalImages = images.flatMap((imageEntry) => (
                                imageEntry.modalImage ? [imageEntry.modalImage] : []
                            ));
                            Modal.show({
                                component: AttachmentImagePreviewModal,
                                props: {
                                    images: modalImages,
                                    initialIndex: Math.min(imageIndex, Math.max(0, modalImages.length - 1)),
                                },
                            });
                        }}
                    />
                )
            ))}
        </View>
    );
});
