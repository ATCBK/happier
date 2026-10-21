import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import { ImageWell } from '@/components/ui/media/ImageWell';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

import type {
  MarkdownDocumentImage,
  MarkdownImageDocument,
  MarkdownImageResolver,
} from './markdownImages';

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function imageTitle(image: MarkdownDocumentImage): string {
  if (image.source.kind === 'workspace') return basename(image.source.path);
  return image.alt || image.destination;
}

function imageSource(
  image: MarkdownDocumentImage,
  scope: WorkspaceScopeBase | undefined,
  remoteLoaded: boolean,
): UseFilePreviewSourceInput | null {
  if (image.source.kind === 'workspace' && scope) {
    return {
      enabled: true,
      source: { kind: 'workspace', scope, filePath: image.source.path },
      ...buildWorkspacePreviewIdentity(scope, image.source.path),
    };
  }
  if (image.source.kind === 'remote' && remoteLoaded) {
    return { enabled: true, source: { kind: 'uri', uri: image.source.url } };
  }
  return null;
}

/**
 * A standalone Markdown image (P2 §3.9, lab files FV3): a workspace image renders at column width in
 * the image well and opens the Media stage with the document's images; remote images wait behind one
 * line per document ("2 remote images not loaded · Load") above the first one.
 */
export function MarkdownImageBlock(
  props: Readonly<{
    sourceStart: number;
  destination: string;
    document: MarkdownImageDocument;
    images: MarkdownImageResolver;
    scope?: WorkspaceScopeBase;
  }>,
) {
  const { theme } = useUnistyles();
  const stage = useMediaStage();
  const originRef = React.useRef<View | null>(null);
  const image = props.document.images.find(
    (entry) => entry.sourceStart === props.sourceStart && entry.destination === props.destination,
  );
  if (!image) return null;
  const remoteLoaded = props.images.remoteLoaded;
  const firstRemote = props.document.images.find(
    (entry) => entry.source.kind === 'remote',
  );
  const showRemoteLine =
    image.source.kind === 'remote' && !remoteLoaded && firstRemote === image;

  if (image.source.kind === 'blocked') {
    return (
      <Text
        variant="meta"
        style={[styles.caption, { color: theme.colors.text.tertiary }]}
      >
        {image.alt || t('files.viewer.imageOutsideWorkspace')}
      </Text>
    );
  }
  if (showRemoteLine) {
    return (
      <View style={styles.block}>
        <SurfaceFreshnessLine
          glyph="image"
          reason={t('files.viewer.remoteImages', {
            count: props.document.remoteImageCount,
          })}
          action={{
            label: t('files.viewer.loadRemoteImages'),
            onPress: props.images.onLoadRemote,
            testID: 'markdown-load-remote-images',
          }}
          testID="markdown-remote-images"
        />
      </View>
    );
  }
  const source = imageSource(image, props.scope, remoteLoaded);
  if (!source) return null;
  const kind =
    image.source.kind === 'workspace' &&
    resolveFileViewerKind({ path: image.source.path }).kind === 'svg'
      ? 'svg'
      : 'image';
  const viewer =
    image.source.kind === 'workspace'
      ? resolveFileViewerKind({ path: image.source.path })
      : null;
  const open = () => {
    const gallery = props.document.gallery;
    const items: MediaStageItem[] = [];
    let index = 0;
    for (const entry of gallery) {
      const entrySource = imageSource(entry, props.scope, remoteLoaded);
      if (!entrySource) continue;
      if (entry === image) index = items.length;
      const entryViewer =
        entry.source.kind === 'workspace'
          ? resolveFileViewerKind({ path: entry.source.path })
          : null;
      items.push({
        kind: entryViewer?.kind === 'svg' ? 'svg' : 'image',
        alphaCapable: entryViewer?.alphaCapable ?? false,
        title: imageTitle(entry),
        source: entrySource,
        ...(entry === image ? { originRef } : {}),
      });
    }
    if (items.length > 0) stage.open(items, index);
  };
  const caption =
    image.source.kind === 'workspace'
      ? [image.source.path, image.alt].filter(Boolean).join(' · ')
      : image.alt;
  return (
    <View style={styles.block}>
      <ImageWell
        kind={kind}
        title={image.alt || imageTitle(image)}
        source={source}
        alphaCapable={viewer?.alphaCapable ?? false}
        layout="inline"
        originRef={originRef}
        onOpenStage={open}
        testID="markdown-image"
      />
      {caption ? (
        <Text
          variant="meta"
          style={[styles.caption, { color: theme.colors.text.secondary }]}
          numberOfLines={2}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    alignSelf: 'stretch',
    marginVertical: theme.space.s8,
    gap: theme.space.s6,
  },
  caption: {
    alignSelf: 'stretch',
  },
}));
