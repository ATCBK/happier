import * as React from 'react';
import { View } from 'react-native';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { FileIcon } from '@/components/ui/media/FileIcon';
import { ImageWell, type ImageWellInfo } from '@/components/ui/media/ImageWell';
import type { PdfPageInfo } from '@/components/ui/media/pdf/PdfViewerStates';
import type { PdfViewPosition } from '@/components/ui/media/pdf/pdfViewPosition';
import type { PdfZoom } from '@/components/ui/media/pdf/pdfZoom';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SessionPaneLazyLoader } from '@/components/sessions/panes/SessionPaneLazyLoader';
import type { FileViewerClass } from '@/scm/utils/filePresentation';
import { t } from '@/text';

import type { MediaPlayerBodyProps } from './MediaPlayerBody';
import type { PdfViewerProps } from '@/components/ui/media/pdf/PdfViewerStates';

export type FileViewerBodyProps = Readonly<{
  /** From `resolveFileViewerKind` for this file version. */
  viewer: FileViewerClass;
  title: string;
  /** Preview bytes with the page's cache identity (`buildWorkspacePreviewIdentity`), so the stage reuses them. */
  source: UseFilePreviewSourceInput;
  sizeBytes?: number | null;
  /** SVG text the page already read for Source / Changes. */
  svgText?: string | null;
  isActive: boolean;
  findSurfaceId: string;
  /** `fill` (default): the body is the page. `inline`: pictures take the column width (Artifact pages). */
  layout?: 'fill' | 'inline';
  /** False where the picture must stay put (a stage already holds it). Default: tap opens the stage. */
  expandable?: boolean;
  openFile?: () => void;
  onDownload?: () => void;
  onOpenInDefaultApp?: () => void;
  /** Hands the file to the viewer chooser's built-in text viewer (binary kinds). */
  onOpenAsText?: () => void;
  onImageInfo?: (info: ImageWellInfo) => void;
  pdf?: Readonly<{
    zoom: PdfZoom;
    onZoomChange: (zoom: PdfZoom) => void;
    position?: PdfViewPosition | null;
    onPositionChange?: (position: PdfViewPosition) => void;
    onPageInfo?: (info: PdfPageInfo) => void;
    showPagePill?: boolean;
  }>;
  testID?: string;
}>;

const loadMediaPlayerBody = () =>
  import('./MediaPlayerBody').then((module) => module.MediaPlayerBody);
const loadPdfViewer = () =>
  import('@/components/ui/media/pdf/PdfViewer').then(
    (module) => module.PdfViewer,
  );

/** Binary identity (lab files FV2b): what the file is and what you can do with it. */
function BinaryIdentity(props: FileViewerBodyProps) {
  const kind = t(props.viewer.labelKey as never) as string;
  const facts =
    typeof props.sizeBytes === 'number'
      ? `${kind} · ${formatHappierDataBytes(props.sizeBytes, { kind: 'storage' })}`
      : kind;
  return (
    <View style={styles.page} testID={props.testID}>
      <SurfaceStateCard
        testID={props.testID ? `${props.testID}-identity` : 'file-binary-identity'}
        // Not a failure: the file is what it is, and Download is the one thing to do with it (primary, P2 §3.8).
        kind="empty"
        size="pane"
        icon={<FileIcon fileName={props.title} size={40} appearance="line" />}
        title={props.title}
        reason={facts}
        {...(props.onDownload
          ? {
              action: {
                label: t('files.viewer.download'),
                onPress: props.onDownload,
                testID: props.testID ? `${props.testID}:download` : 'file-binary-download',
              },
            }
          : {})}
        {...(props.onOpenInDefaultApp
          ? {
              secondaryAction: {
                label: t('files.viewer.openInDefaultApp'),
                onPress: props.onOpenInDefaultApp,
              },
            }
          : {})}
        {...(props.onOpenAsText
          ? {
              learnMore: {
                label: t('files.viewer.openAsText'),
                onPress: props.onOpenAsText,
                testID: 'file-binary-open-as-text',
              },
            }
          : {})}
      />
    </View>
  );
}

/**
 * The body for every non-code kind (P2 §3.1): image and SVG wells, PDF, video and audio, binary
 * identity. The File page (P3) and Artifacts mount it; heavy engines load only when that kind opens.
 */
export function FileViewerBody(props: FileViewerBodyProps) {
  const originRef = React.useRef<View | null>(null);
  // Hosts without per-file tab state (Artifacts) still get a working zoom.
  const [localZoom, setLocalZoom] = React.useState<PdfZoom>('fit-width');
  const pdf = props.pdf ?? { zoom: localZoom, onZoomChange: setLocalZoom };
  const { viewer } = props;
  const stage = useMediaStage();
  const stageKind =
    viewer.kind === 'image' || viewer.kind === 'svg' ? viewer.kind : null;
  const openInStage = React.useMemo(() => {
    if (props.expandable === false || !stageKind) return undefined;
    return () =>
      stage.open(
        [
          {
            kind: stageKind,
            title: props.title,
            source: props.source,
            sizeBytes: props.sizeBytes ?? null,
            originRef,
            ...(props.openFile ? { openFile: props.openFile } : {}),
          },
        ],
        0,
      );
  }, [
    props.expandable,
    stage,
    props.openFile,
    props.sizeBytes,
    props.source,
    props.title,
    stageKind,
  ]);

  switch (viewer.kind) {
    case 'image':
    case 'svg':
      return (
        <ImageWell
          kind={viewer.kind}
          title={props.title}
          source={props.source}
          svgText={props.svgText ?? null}
          alphaCapable={viewer.alphaCapable}
          layout={props.layout ?? 'fill'}
          originRef={originRef}
          {...(openInStage ? { onOpenStage: openInStage } : {})}
          {...(props.onImageInfo ? { onImageInfo: props.onImageInfo } : {})}
          {...(props.testID ? { testID: props.testID } : {})}
        />
      );
    case 'video':
    case 'audio':
      return (
        <SessionPaneLazyLoader<MediaPlayerBodyProps>
          testID="file-media-player"
          load={loadMediaPlayerBody}
          props={{
            kind: viewer.kind,
            title: props.title,
            source: props.source,
            isActive: props.isActive,
            ...(props.onDownload ? { onDownload: props.onDownload } : {}),
            ...(props.onOpenInDefaultApp
              ? { onOpenInDefaultApp: props.onOpenInDefaultApp }
              : {}),
            ...(props.testID ? { testID: props.testID } : {}),
          }}
        />
      );
    case 'pdf':
      return (
        <SessionPaneLazyLoader<PdfViewerProps>
          testID="file-pdf-viewer"
          load={loadPdfViewer}
          props={{
            title: props.title,
            source: props.source,
            isActive: props.isActive,
            findSurfaceId: props.findSurfaceId,
            ...pdf,
            ...(props.onOpenInDefaultApp
              ? { onOpenInDefaultApp: props.onOpenInDefaultApp }
              : {}),
            ...(props.testID ? { testID: props.testID } : {}),
          }}
        />
      );
    default:
      return <BinaryIdentity {...props} />;
  }
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
    padding: theme.space.s32,
  },
}));
