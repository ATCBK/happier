import * as React from 'react';
import { PixelRatio, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import {
  coverRectFlipOrigin,
  useRectFlip,
  type WindowFlightRect,
} from '@/components/ui/motion/rectFlight';
import { rectFlipFrame } from '@/components/ui/motion/rectFlipGeometry';
import { measureInWindow } from '@/components/ui/popover/measure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { SessionPaneLazyLoader } from '@/components/sessions/panes/SessionPaneLazyLoader';
import type { MediaPlayerBodyProps } from '@/components/workspaces/files/file/MediaPlayerBody';
import type { PdfViewerProps } from '../pdf/PdfViewerStates';
import type { PdfZoom } from '../pdf/pdfZoom';

import { MediaPicture, type MediaPictureSize } from '../MediaPicture';
import { useFilePreviewSource } from '../useFilePreviewSource';
import { useWheelZoom } from '../zoom/useWheelZoom';
import { useZoomableViewport } from '../zoom/useZoomableViewport';
import { dismissPresentation, resolveZoomBounds } from '../zoom/zoomGeometry';
import type { MediaStageItem, MediaStageProps } from './mediaStageItems';
import { hideStageOrigin } from './hideStageOrigin';
import { useMediaStageGallery } from './useMediaStageGallery';
import { useMediaStageKeyboard } from './useMediaStageKeyboard';

type Rect = WindowFlightRect;
type Phase = 'opening' | 'open' | 'closing';

/** Desktop chrome geometry, composed from the stage's own parts (lab files MS1 spec). */
const TOP_BAR_HEIGHT = 44;
const STRIP_THUMB_SIZE = 56;
const STRIP_RING_WIDTH = 2;

const isPicture = (item: MediaStageItem) =>
  item.kind === 'image' || item.kind === 'svg';

function fitSize(size: MediaPictureSize, viewport: MediaPictureSize): MediaPictureSize {
  const scale = Math.min(1, viewport.width / size.width, viewport.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

function fitRect(size: MediaPictureSize, viewport: Rect): Rect {
  const scale = Math.min(
    1,
    viewport.width / size.width,
    viewport.height / size.height,
  );
  const width = size.width * scale;
  const height = size.height * scale;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y + (viewport.height - height) / 2,
    width,
    height,
  };
}

/** Web saves the shown bytes as a download; native hands the preview cache file to the share sheet. */
async function saveStageMedia(uri: string, name: string): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    downloadWebFile(blob, name, async () => {});
    return;
  }
  await shareNativeCacheFile({ fileUri: uri, name, dialogTitle: name });
}

async function measureOrigin(item: MediaStageItem): Promise<Rect | null> {
  const node = item.originRef?.current;
  if (!node) return null;
  const rect = await measureInWindow(node);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function itemLabel(
  item: MediaStageItem,
  size: MediaPictureSize | null,
): string {
  return size
    ? t('files.viewer.stageItem', {
        name: item.title,
        width: Math.round(size.width),
        height: Math.round(size.height),
      })
    : item.title;
}

type ViewerHandle = Readonly<{
  visibleFrame: () => Rect | null;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  actual: () => void;
}>;

type StageViewerProps = Readonly<{
  items: readonly MediaStageItem[];
  index: number;
  viewport: Rect;
  window: Rect;
  phase: Phase;
  reducedMotion: boolean;
  progress: SharedValue<number>;
  dragProgress: SharedValue<number>;
  immersive: SharedValue<number>;
  onSize: (index: number, size: MediaPictureSize | null) => void;
  onPage: (direction: -1 | 1) => void;
  onDismiss: (velocityY: number) => void;
  onTap: () => void;
  onZoomChange: (percent: number | null) => void;
  /** While zoomed the picture stays inside the viewport, so the title and capsules stay legible over it. */
  clip: boolean;
  onOpenFile?: () => void;
}>;

/** A fitted, non-interactive neighbour on either side of the current page. */
function NeighbourPicture(
  props: Readonly<{ item: MediaStageItem; viewport: Rect; enabled: boolean }>,
) {
  const preview = useFilePreviewSource({
    ...props.item.source,
    enabled:
      props.enabled && isPicture(props.item) && props.item.source.enabled,
  });
  const [size, setSize] = React.useState<MediaPictureSize | null>(null);
  if (preview.status !== 'loaded') return null;
  const rect = size ? fitRect(size, { ...props.viewport, x: 0, y: 0 }) : null;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, stageStyles.centre]}
    >
      <MediaPicture
        kind={props.item.kind === 'svg' ? 'svg' : 'image'}
        uri={preview.uri}
        size={rect ? { width: rect.width, height: rect.height } : null}
        onIntrinsicSize={setSize}
      />
    </View>
  );
}

const StageViewer = React.forwardRef<ViewerHandle, StageViewerProps>(
  function StageViewer(props, ref) {
    const { theme } = useUnistyles();
    const item = props.items[props.index]!;
    const picture = isPicture(item);
    const preview = useFilePreviewSource({
      ...item.source,
      enabled: picture && item.source.enabled,
    });
    const [size, setSize] = React.useState<MediaPictureSize | null>(null);
    const [failed, setFailed] = React.useState<string | null>(null);
    const viewportSize = React.useMemo(
      () => ({ width: props.viewport.width, height: props.viewport.height }),
      [props.viewport.width, props.viewport.height],
    );
    const { onSize, onZoomChange, onPage, onDismiss, onTap } = props;
    const index = props.index;

    React.useEffect(() => {
      if (!picture) onSize(index, null);
      else if (preview.status === 'error' || failed) onSize(index, null);
      else if (preview.status === 'loading' || preview.status === 'disabled')
        onSize(index, null);
    }, [failed, index, onSize, picture, preview.status]);
    const handleIntrinsicSize = React.useCallback(
      (next: MediaPictureSize) => {
        setSize((current) =>
          current?.width === next.width && current.height === next.height
            ? current
            : next,
        );
        onSize(index, next);
      },
      [index, onSize],
    );

    const hasPrevious = props.index > 0;
    const hasNext = props.index < props.items.length - 1;
    const zoom = useZoomableViewport({
      imageSize: size ?? { width: 0, height: 0 },
      viewportSize,
      reducedMotion: props.reducedMotion,
      hasPrevious,
      hasNext,
      pageGap: theme.space.s24,
      onDismiss,
      ...(props.items.length > 1
        ? { onPage: (direction: -1 | 1) => onPage(direction) }
        : {}),
      onTap,
      onZoomSettled: (aboveFit: boolean) => {
        // 100% is one image pixel per device pixel: what the "1" key and a desktop click choose.
        onZoomChange(
          size && aboveFit
            ? Math.round(zoom.scale.value * PixelRatio.get() * 100)
            : null,
        );
      },
      onZoomBoundary: () => {
        void hapticsLight();
      },
    });

    const viewportRef = React.useRef<View>(null);
    useWheelZoom(viewportRef, zoom.wheelHandlers);

    useAnimatedReaction(
      () => zoom.dismissY.value,
      (dy) => {
        props.dragProgress.value = Math.min(
          1,
          Math.abs(dy) / (0.33 * Math.max(1, viewportSize.height)),
        );
      },
      [viewportSize.height],
    );

    React.useImperativeHandle(
      ref,
      () => ({
        visibleFrame: () => {
          if (!size) return null;
          const fitted = fitRect(size, props.viewport);
          const bounds = resolveZoomBounds(size, viewportSize, 1);
          const zoomRatio =
            bounds.min === 0 ? 1 : zoom.scale.value / bounds.min;
          const dismissScale = props.reducedMotion
            ? 1
            : dismissPresentation(zoom.dismissY.value, viewportSize.height)
                .scale;
          const width = fitted.width * zoomRatio * dismissScale;
          const height = fitted.height * zoomRatio * dismissScale;
          const cx =
            props.viewport.x +
            props.viewport.width / 2 +
            zoom.translationX.value * dismissScale +
            zoom.dismissX.value;
          const cy =
            props.viewport.y +
            props.viewport.height / 2 +
            zoom.translationY.value * dismissScale +
            zoom.dismissY.value;
          return { x: cx - width / 2, y: cy - height / 2, width, height };
        },
        zoomIn: zoom.zoomIn,
        zoomOut: zoom.zoomOut,
        fit: zoom.fit,
        actual: zoom.actual,
      }),
      [props.reducedMotion, props.viewport, size, viewportSize, zoom],
    );

    const backdropStyle = useAnimatedStyle(() => ({
      opacity:
        props.progress.value *
        dismissPresentation(zoom.dismissY.value, viewportSize.height).backdrop,
    }));
    const immersiveStyle = useAnimatedStyle(() => ({
      opacity: props.immersive.value,
    }));

    const neighboursEnabled = props.phase === 'open';
    const pageOffset = props.viewport.width + theme.space.s24;
    const hidden = props.phase !== 'open' && picture && size !== null;
    const label = itemLabel(item, size);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.surface.base },
            backdropStyle,
          ]}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.colors.overlay.stageImmersive },
              immersiveStyle,
            ]}
          />
        </Animated.View>
        <View
          ref={viewportRef}
          style={[
            stageStyles.viewport,
            {
              left: props.viewport.x,
              top: props.viewport.y,
              width: props.viewport.width,
              height: props.viewport.height,
            },
            props.clip ? stageStyles.clip : null,
          ]}
        >
          {picture ? (
            <GestureDetector gesture={zoom.gesture}>
              <Animated.View
                style={[StyleSheet.absoluteFill, zoom.pageStyle]}
                collapsable={false}
              >
                {hasPrevious ? (
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      { transform: [{ translateX: -pageOffset }] },
                    ]}
                  >
                    <NeighbourPicture
                      item={props.items[props.index - 1]!}
                      viewport={props.viewport}
                      enabled={neighboursEnabled}
                    />
                  </View>
                ) : null}
                {hasNext ? (
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      { transform: [{ translateX: pageOffset }] },
                    ]}
                  >
                    <NeighbourPicture
                      item={props.items[props.index + 1]!}
                      viewport={props.viewport}
                      enabled={neighboursEnabled}
                    />
                  </View>
                ) : null}
                <Animated.View
                  style={[
                    StyleSheet.absoluteFill,
                    stageStyles.centre,
                    zoom.dismissStyle,
                    hidden ? stageStyles.hidden : null,
                  ]}
                >
                  {preview.status === 'loaded' && !failed ? (
                    <Animated.View
                      // The picture never takes the pointer (a web <img> would start a native image drag);
                      // the viewport's recognizers own every press, pan and pinch.
                      pointerEvents="none"
                      style={zoom.contentStyle}
                      accessible
                      accessibilityRole="image"
                      accessibilityLabel={label}
                    >
                      <MediaPicture
                        kind={item.kind === 'svg' ? 'svg' : 'image'}
                        uri={preview.uri}
                        size={
                          size
                            ? fitSize(size, viewportSize)
                            : null
                        }
                        onIntrinsicSize={handleIntrinsicSize}
                        onError={setFailed}
                        testID="media-stage-image"
                      />
                    </Animated.View>
                  ) : preview.status === 'error' || failed ? (
                    <SurfaceStateCard
                      kind="error"
                      size="pane"
                      title={t('files.viewer.loadFailed', { name: item.title })}
                      diagnosticCode={preview.error ?? failed}
                      {...(item.openFile
                        ? {
                            action: {
                              label: t('files.viewer.openFile'),
                              onPress: item.openFile,
                            },
                          }
                        : {})}
                    />
                  ) : (
                    <ActivitySpinner
                      size="small"
                      color={theme.colors.text.secondary}
                    />
                  )}
                </Animated.View>
              </Animated.View>
            </GestureDetector>
          ) : (
            <View style={StyleSheet.absoluteFill}>
              <StageDocumentItem item={item} isActive={props.phase === 'open'} />
            </View>
          )}
        </View>
      </View>
    );
  },
);

const loadStageMediaPlayer = () =>
  import('@/components/workspaces/files/file/MediaPlayerBody').then((module) => module.MediaPlayerBody);
const loadStagePdfViewer = () => import('../pdf/PdfViewer').then((module) => module.PdfViewer);

/** Video and PDF items render their own bodies in the stage (lab MS1f); pictures use the zoom viewport. */
function StageDocumentItem(props: Readonly<{ item: MediaStageItem; isActive: boolean }>) {
  const [zoom, setZoom] = React.useState<PdfZoom>('fit-width');
  if (props.item.kind === 'video') {
    return (
      <SessionPaneLazyLoader<MediaPlayerBodyProps>
        testID="media-stage-video"
        load={loadStageMediaPlayer}
        props={{ kind: 'video', title: props.item.title, source: props.item.source, isActive: props.isActive }}
      />
    );
  }
  return (
    <SessionPaneLazyLoader<PdfViewerProps>
      testID="media-stage-pdf"
      load={loadStagePdfViewer}
      props={{
        title: props.item.title,
        source: props.item.source,
        isActive: props.isActive,
        findSurfaceId: 'media-stage-pdf',
        presentation: 'stage',
        zoom,
        onZoomChange: setZoom,
      }}
    />
  );
}

function StageCapsule(props: Readonly<{ children: React.ReactNode }>) {
  return (
    <GlassPanel shadowLevel={2} innerShadow={false} style={stageStyles.capsule}>
      {props.children}
    </GlassPanel>
  );
}

function StripThumb(
  props: Readonly<{
    item: MediaStageItem;
    selected: boolean;
    enabled: boolean;
    onPress: () => void;
    label: string;
  }>,
) {
  const { theme } = useUnistyles();
  const picture = isPicture(props.item);
  const preview = useFilePreviewSource({
    ...props.item.source,
    enabled: props.enabled && picture && props.item.source.enabled,
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[
        stageStyles.thumb,
        props.selected ? { borderColor: theme.colors.border.focus } : null,
      ]}
    >
      <View style={stageStyles.thumbInner}>
        {picture && preview.status === 'loaded' ? (
          <MediaPicture
            kind={props.item.kind === 'svg' ? 'svg' : 'image'}
            uri={preview.uri}
            size={{ width: STRIP_THUMB_SIZE, height: STRIP_THUMB_SIZE }}
                    fit="cover"
            style={stageStyles.thumbImage}
          />
        ) : (
          <Icon
            name={
              props.item.kind === 'video'
                ? 'video-camera'
                : props.item.kind === 'pdf'
                  ? 'file-text'
                  : 'image'
            }
            size={20}
            color={theme.colors.text.secondary}
          />
        )}
      </View>
    </Pressable>
  );
}

/**
 * The Media stage (P2 §3.4, lab files MS1): one full-screen layer for every image, SVG, PDF and video.
 * The picture flies from its thumbnail onto the page colour, zooms about the focal point, pages through a
 * frozen gallery and drags back home. The modal owner keeps focus trap, portal and focus return.
 */
export function MediaStage(props: MediaStageProps & CustomModalInjectedProps) {
  const { theme } = useUnistyles();
  const gallery = useMediaStageGallery(props.items, props.initialIndex);
  const window = useWindowDimensions();
  const insets = useChromeSafeAreaInsets();
  const phone = useDeviceType() === 'phone';
  const reducedMotion = useReducedMotionPreference();
  const [phase, setPhase] = React.useState<Phase>('opening');
  const [immersive, setImmersive] = React.useState(false);
  const [zoomPercent, setZoomPercent] = React.useState<number | null>(null);
  const [flightSize, setFlightSize] = React.useState<MediaPictureSize | null>(
    null,
  );
  const sizes = React.useRef(new Map<number, MediaPictureSize | null>());
  const viewerRef = React.useRef<ViewerHandle>(null);
  const flip = useRectFlip({ initialProgress: 0 });
  const dragProgress = useSharedValue(0);
  const immersiveValue = useSharedValue(0);
  const chromeValue = useSharedValue(0);
  const opened = React.useRef(false);
  const item = gallery.currentItem;
  const multiple = gallery.items.length > 1;
  const showStrip = !phone && multiple;

  const windowRect = React.useMemo<Rect>(
    () => ({ x: 0, y: 0, width: window.width, height: window.height }),
    [window.width, window.height],
  );
  const viewport = React.useMemo<Rect>(() => {
    if (phone || immersive) return windowRect;
    const top = theme.space.s12 + TOP_BAR_HEIGHT + theme.space.s16;
    const bottom = showStrip
      ? theme.space.s16 * 2 + STRIP_THUMB_SIZE + theme.space.s4 * 2
      : top;
    const side = theme.space.s32;
    return {
      x: side,
      y: top,
      width: Math.max(1, window.width - side * 2),
      height: Math.max(1, window.height - top - bottom),
    };
  }, [
    immersive,
    phone,
    showStrip,
    theme.space,
    window.height,
    window.width,
    windowRect,
  ]);

  React.useEffect(() => {
    immersiveValue.value = withTiming(immersive ? 1 : 0, {
      duration: reducedMotion
        ? motionTokens.durationMs.fast
        : motionTokens.durationMs.base,
      easing: reanimatedMotionTokens.easing.standard,
    });
  }, [immersive, immersiveValue, reducedMotion]);
  const [flightStarted, setFlightStarted] = React.useState(false);
  React.useEffect(() => {
    if (flightStarted && phase !== 'closing' && !immersive) {
      const fadeIn = withTiming(1, { duration: motionTokens.durationMs.fast });
      chromeValue.value =
        phase === 'opening' && !reducedMotion
          ? withDelay(motionTokens.mediaStage.chromeDelayMs, fadeIn)
          : fadeIn;
    } else {
      chromeValue.value = withTiming(0, {
        duration: motionTokens.durationMs.fast,
      });
    }
  }, [chromeValue, flightStarted, immersive, phase, reducedMotion]);

  // From the first flight frame until the stage unmounts, the current item's thumbnail slot is empty.
  React.useLayoutEffect(() => {
    const node = flightStarted ? item.originRef?.current : null;
    return node ? hideStageOrigin(node) : undefined;
  }, [flightStarted, item.originRef]);

  const finishOpen = React.useCallback(
    () => setPhase((current) => (current === 'opening' ? 'open' : current)),
    [],
  );

  const handleSize = React.useCallback(
    (index: number, size: MediaPictureSize | null) => {
      sizes.current.set(index, size);
      if (opened.current || index !== gallery.index) return;
      opened.current = true;
      const target = size ? fitRect(size, viewport) : viewport;
      setFlightSize(size);
      if (!size || reducedMotion) {
        flip.openFrom(null, target, finishOpen);
        setFlightStarted(true);
        return;
      }
      void measureOrigin(item).then((origin) => {
        flip.openFrom(
          origin ? coverRectFlipOrigin(origin, size) : null,
          target,
          finishOpen,
        );
        setFlightStarted(true);
      });
    },
    [finishOpen, flip, gallery.index, item, reducedMotion, viewport],
  );

  const close = React.useCallback(
    (velocityY?: number) => {
      if (phase === 'closing') return;
      const size = sizes.current.get(gallery.index) ?? null;
      const frame =
        phase === 'open' ? (viewerRef.current?.visibleFrame() ?? null) : null;
      if (frame) {
        flip.from.value = rectFlipFrame(frame);
        flip.to.value = rectFlipFrame(frame);
      }
      setFlightSize(frame && size ? size : null);
      setPhase('closing');
      const run = (origin: Rect | null) =>
        flip.closeTo(
          origin && size ? coverRectFlipOrigin(origin, size) : null,
          {
            ...(velocityY !== undefined ? { velocityY } : {}),
            onComplete: props.onClose,
          },
        );
      if (!size || reducedMotion) run(null);
      else void measureOrigin(item).then(run);
    },
    [flip, gallery.index, item, phase, props.onClose, reducedMotion],
  );

  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.modal,
    allowEditableTarget: true,
    onEscape: () => {
      close();
      return true;
    },
  });

  const goTo = React.useCallback(
    (next: number) => {
      if (next < 0 || next >= gallery.items.length || next === gallery.index)
        return;
      gallery.select(next);
      setZoomPercent(null);
      dragProgress.value = 0;
      const nextItem = gallery.items[next]!;
      announceAccessibilityMessage(
        `${nextItem.title}, ${t('files.viewer.stageCounter', { current: next + 1, total: gallery.items.length })}`,
      );
    },
    [dragProgress, gallery],
  );

  useMediaStageKeyboard(
    phase !== 'closing'
      ? {
          previous: () => goTo(gallery.index - 1),
          next: () => goTo(gallery.index + 1),
          zoomIn: () => viewerRef.current?.zoomIn(),
          zoomOut: () => viewerRef.current?.zoomOut(),
          fit: () => viewerRef.current?.fit(),
          actualSize: () => viewerRef.current?.actual(),
        }
      : null,
  );

  const chromeStyle = useAnimatedStyle(() => ({
    opacity: chromeValue.value * Math.max(0, 1 - dragProgress.value * 4),
  }));
  const chromeInteractive = phase === 'open' && !immersive;
  const counter = multiple
    ? t('files.viewer.stageCounter', {
        current: gallery.index + 1,
        total: gallery.items.length,
      })
    : null;

  const flightTarget = flightSize ? fitRect(flightSize, viewport) : null;
  const flightItem = item;
  // The current picture's bytes (a cache hit on the viewer's identity): the flight layer and Save read them.
  const flightPreview = useFilePreviewSource({
    ...flightItem.source,
    enabled: isPicture(flightItem) && flightItem.source.enabled,
  });
  const savable = flightPreview.status === 'loaded' ? flightPreview.uri : null;
  const save = React.useCallback(() => {
    if (!savable) return;
    void saveStageMedia(savable, item.title);
  }, [item.title, savable]);

  const topInset = phone ? insets.top + theme.space.s6 : theme.space.s12;

  return (
    <View
      style={StyleSheet.absoluteFill}
      accessibilityViewIsModal
      testID="media-stage"
    >
      <StageViewer
        key={gallery.index}
        ref={viewerRef}
        items={gallery.items}
        index={gallery.index}
        viewport={viewport}
        window={windowRect}
        phase={phase}
        reducedMotion={reducedMotion}
        progress={flip.progress}
        dragProgress={dragProgress}
        immersive={immersiveValue}
        onSize={handleSize}
        onPage={(direction) => goTo(gallery.index + direction)}
        onDismiss={(velocityY) => close(velocityY)}
        onTap={() => setImmersive((value) => !value)}
        onZoomChange={setZoomPercent}
        clip={zoomPercent !== null && !phone && !immersive}
        {...(item.openFile ? { onOpenFile: item.openFile } : {})}
      />

      {phase !== 'open' && flightTarget && flightPreview.status === 'loaded' ? (
        <Animated.View pointerEvents="none" style={flip.clipStyle}>
          <Animated.View
            style={[
              { width: flightTarget.width, height: flightTarget.height },
              flip.clippedImageStyle,
            ]}
          >
            <MediaPicture
              kind={flightItem.kind === 'svg' ? 'svg' : 'image'}
              uri={flightPreview.uri}
              size={{ width: flightTarget.width, height: flightTarget.height }}
            />
          </Animated.View>
        </Animated.View>
      ) : null}

      <Animated.View
        pointerEvents={chromeInteractive ? 'box-none' : 'none'}
        style={[StyleSheet.absoluteFill, chromeStyle]}
      >
        <View
          style={[
            stageStyles.topBar,
            { top: topInset, left: theme.space.s12, right: theme.space.s12 },
          ]}
          pointerEvents="box-none"
        >
          <StageCapsule>
            <IconButton
              variant="plain"
              iconName="x"
              accessibilityLabel={t('common.close')}
              tooltip={t('common.close')}
              onPress={() => close()}
              testID="media-stage-close"
            />
          </StageCapsule>
          <View style={stageStyles.title} pointerEvents="none">
            <Text
              variant="body"
              emphasis="semiBold"
              numberOfLines={1}
              style={{ color: theme.colors.text.primary, flexShrink: 1 }}
            >
              {item.title}
            </Text>
            {counter && !phone ? (
              <Text
                variant="body"
                style={[
                  { color: theme.colors.text.secondary },
                  Typography.tabular(),
                ]}
              >
                {counter}
              </Text>
            ) : null}
          </View>
          {zoomPercent !== null || item.openFile || savable ? (
            <StageCapsule>
              {zoomPercent !== null && !phone ? (
                <>
                  <IconButton
                    variant="plain"
                    iconName="minus"
                    accessibilityLabel={t('files.viewer.zoomOut')}
                    tooltip={t('files.viewer.zoomOut')}
                    onPress={() => viewerRef.current?.zoomOut()}
                  />
                  <Text
                    variant="meta"
                    style={[
                      stageStyles.zoomLabel,
                      { color: theme.colors.text.primary },
                      Typography.tabular(),
                    ]}
                  >
                    {t('files.viewer.zoomPercent', { percent: zoomPercent })}
                  </Text>
                  <IconButton
                    variant="plain"
                    iconName="plus"
                    accessibilityLabel={t('files.viewer.zoomIn')}
                    tooltip={t('files.viewer.zoomIn')}
                    onPress={() => viewerRef.current?.zoomIn()}
                  />
                </>
              ) : null}
              {savable ? (
                <IconButton
                  variant="plain"
                  iconName={Platform.OS === 'web' ? 'download' : 'share'}
                  accessibilityLabel={Platform.OS === 'web' ? t('files.viewer.download') : t('files.viewer.share')}
                  tooltip={Platform.OS === 'web' ? t('files.viewer.download') : t('files.viewer.share')}
                  onPress={save}
                  testID="media-stage-save"
                />
              ) : null}
              {item.openFile && !phone ? (
                <IconButton
                  variant="plain"
                  iconName="arrow-square-out"
                  accessibilityLabel={t('files.viewer.openFile')}
                  tooltip={t('files.viewer.openFile')}
                  onPress={item.openFile}
                  testID="media-stage-open-file"
                />
              ) : null}
            </StageCapsule>
          ) : (
            <View style={stageStyles.capsulePlaceholder} />
          )}
        </View>

        {showStrip ? (
          <View
            style={[stageStyles.stripDock, { bottom: theme.space.s16 }]}
            pointerEvents="box-none"
          >
            <GlassPanel
              radius={theme.space.s16}
              shadowLevel={2}
              innerShadow={false}
              style={stageStyles.strip}
            >
              <View
                style={stageStyles.stripRow}
                accessibilityRole="tablist"
                accessibilityLabel={t('files.viewer.stageGallery', {
                  count: gallery.items.length,
                })}
              >
                {gallery.items.map((entry, entryIndex) => (
                  <StripThumb
                    key={entryIndex}
                    item={entry}
                    selected={entryIndex === gallery.index}
                    enabled={phase === 'open'}
                    label={entry.title}
                    onPress={() => goTo(entryIndex)}
                  />
                ))}
              </View>
            </GlassPanel>
          </View>
        ) : null}

        {phone && (multiple || item.openFile) ? (
          <View
            style={[
              stageStyles.stripDock,
              { bottom: insets.bottom + theme.space.s24 },
            ]}
            pointerEvents="box-none"
          >
            <StageCapsule>
              {counter ? (
                <Text
                  variant="body"
                  style={[
                    stageStyles.phoneCounter,
                    { color: theme.colors.text.secondary },
                    Typography.tabular(),
                  ]}
                >
                  {counter}
                </Text>
              ) : null}
              {item.openFile ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={item.openFile}
                  style={stageStyles.phoneLink}
                  testID="media-stage-open-file"
                >
                  <Text
                    variant="body"
                    emphasis="medium"
                    style={{ color: theme.colors.text.link }}
                  >
                    {t('files.viewer.openFile')}
                  </Text>
                </Pressable>
              ) : null}
            </StageCapsule>
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

const stageStyles = StyleSheet.create((theme) => ({
  viewport: {
    position: 'absolute',
  },
  clip: {
    overflow: 'hidden',
  },
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  hidden: {
    opacity: 0,
  },
  topBar: {
    position: 'absolute',
    height: TOP_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  title: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: theme.space.s8,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
    padding: theme.space.s4,
  },
  capsulePlaceholder: {
    width: TOP_BAR_HEIGHT,
  },
  zoomLabel: {
    paddingHorizontal: theme.space.s6,
    minWidth: theme.space.s48,
    textAlign: 'center',
  },
  stripDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  strip: {
    padding: theme.space.s4,
  },
  stripRow: {
    flexDirection: 'row',
    gap: theme.space.s4,
  },
  thumb: {
    width: STRIP_THUMB_SIZE,
    height: STRIP_THUMB_SIZE,
    borderRadius: theme.space.s12,
    borderWidth: STRIP_RING_WIDTH,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  thumbInner: {
    flex: 1,
    borderRadius: theme.space.s10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.inset,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  phoneCounter: {
    paddingHorizontal: theme.space.s12,
  },
  phoneLink: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s6,
  },
}));
