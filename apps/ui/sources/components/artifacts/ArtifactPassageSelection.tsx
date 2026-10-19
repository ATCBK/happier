import * as React from 'react';
import {
  Platform,
  Pressable,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';

import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import {
  mapMarkdownSourceToRenderedRange,
  mapRenderedSelectionToMarkdownSource,
} from '@/components/markdown/rendering/markdownSelectionSource';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useArtifactActionsClient } from './artifactActionsClient';
import type { DocPassageMarginLocation } from './docPassageMargin';

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;
type Selected = Readonly<{
  range: Readonly<{ start: number; end: number }>;
  top: number;
  left: number;
}>;

/** A passage the Doc shows a thread for; `location` places it in this revision's source. */
export type ArtifactMarginPassage = Readonly<{
  id: string;
  location: DocPassageMarginLocation;
}>;

export type ArtifactPassageMargin = Readonly<{
  passages: readonly ArtifactMarginPassage[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  /** Narrow layouts have no margin: a passage opens its thread instead. */
  onOpen: (id: string) => void;
  renderCard: (id: string) => React.ReactNode;
}>;

type Rect = Readonly<{
  top: number;
  left: number;
  width: number;
  height: number;
}>;

/** The Comment affordance sits above the selection's middle, kept inside the body column. */
const AFFORDANCE_HALF_WIDTH = 56;
const AFFORDANCE_LIFT = 44;
/** The margin opens beside the passage only when the body keeps a readable measure next to it. */
const MARGIN_MIN_FRAME_WIDTH = 860;
const MARGIN_WIDTH = 288;

/**
 * A Doc's Markdown body with its passages (C5 lab K1-S/A/R/ST):
 * - select text, then Comment: the selection is placed in the canonical Markdown source by the
 *   Markdown owner's projection (never by searching for the quote), captured as a passage at the
 *   revision being read, and opens the one Discussion composer with that passage;
 * - each commented passage is marked where its stored source range lands in this revision, and its
 *   thread sits beside it in the margin; a mark and its thread focus each other.
 * Web reads the browser selection and geometry; elsewhere the body renders unchanged.
 */
export function ArtifactPassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision | null;
    margin?: ArtifactPassageMargin;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  if (Platform.OS !== 'web' || props.revision === null)
    return <>{props.children}</>;
  return <WebPassageSelection {...props} revision={props.revision} />;
}

/** Text nodes in document order with their offsets in the element's `textContent`. */
function domRangeAt(
  element: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** Free width between this element's right edge and the right edge of the pane that scrolls it. */
function measureRoomRight(element: HTMLElement): number {
  const right = element.getBoundingClientRect().right;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      const box = parent.getBoundingClientRect();
      return box.left + parent.clientWidth - right;
    }
  }
  return 0;
}

function WebPassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision;
    margin?: ArtifactPassageMargin;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const client = useArtifactActionsClient();
  const scope = useActiveServerAccountScope();
  const container = React.useRef<View>(null);
  const [selected, setSelected] = React.useState<Selected | null>(null);
  const outer = React.useRef<View>(null);
  const [layout, setLayout] = React.useState<Readonly<{ width: number; roomRight: number }>>({ width: 0, roomRight: 0 });
  const [marks, setMarks] = React.useState<
    ReadonlyMap<string, readonly Rect[]>
  >(new Map());
  const [cardHeights, setCardHeights] = React.useState<
    ReadonlyMap<string, number>
  >(new Map());
  const margin = props.margin;
  // The margin sits inside a wide body, or beside a reading column in the page's free gutter.
  const marginMode: 'none' | 'inline' | 'outside' = margin === undefined ? 'none'
    : layout.width >= MARGIN_MIN_FRAME_WIDTH ? 'inline'
      : layout.roomRight >= MARGIN_WIDTH + theme.space.s24 ? 'outside' : 'none';
  const wide = marginMode !== 'none';
  const marksRef = React.useRef(marks);
  marksRef.current = marks;
  const marginRef = React.useRef(margin);
  marginRef.current = margin;
  const wideRef = React.useRef(wide);
  wideRef.current = wide;

  React.useEffect(() => {
    const element = container.current as unknown as HTMLElement | null;
    if (!element || typeof document === 'undefined') return;
    const read = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0)
        return setSelected(null);
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer))
        return setSelected(null);
      const before = document.createRange();
      before.selectNodeContents(element);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const source = mapRenderedSelectionToMarkdownSource({
        markdown: props.markdown,
        rendered: element.textContent ?? '',
        start,
        end: start + range.toString().length,
      });
      if (!source) return setSelected(null);
      // The affordance belongs to where the selection starts, not the middle of a multi-line block.
      const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      const middle = box.left - frame.left + box.width / 2;
      setSelected({
        range: source,
        top: Math.max(0, box.top - frame.top - AFFORDANCE_LIFT),
        left: Math.min(
          Math.max(0, middle - AFFORDANCE_HALF_WIDTH),
          Math.max(0, frame.width - AFFORDANCE_HALF_WIDTH * 2),
        ),
      });
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [props.markdown]);

  // Where each placed passage is drawn: the Markdown owner maps its source range to the rendered
  // text, and the browser gives that text's line boxes. Re-measured when the body reflows.
  const passages = margin?.passages;
  React.useEffect(() => {
    const element = container.current as unknown as HTMLElement | null;
    if (!element || typeof document === 'undefined' || !passages?.length) {
      setMarks(new Map());
      return;
    }
    let frameRequest = 0;
    const measure = () => {
      const rendered = element.textContent ?? '';
      const frame = element.getBoundingClientRect();
      const next = new Map<string, readonly Rect[]>();
      for (const passage of passages) {
        if (passage.location.state === 'detached') continue;
        const at = mapMarkdownSourceToRenderedRange({
          markdown: props.markdown,
          rendered,
          ...passage.location.range,
        });
        const range = at ? domRangeAt(element, at.start, at.end) : null;
        if (!range) continue;
        next.set(
          passage.id,
          [...range.getClientRects()]
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => ({
              top: rect.top - frame.top,
              left: rect.left - frame.left,
              width: rect.width,
              height: rect.height,
            })),
        );
      }
      setMarks(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(measure);
    };
    schedule();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      cancelAnimationFrame(frameRequest);
      observer?.disconnect();
    };
  }, [passages, props.markdown, wide]);

  // A click (not a selection) on a marked passage focuses its thread, or opens it without a margin.
  React.useEffect(() => {
    const element = container.current as unknown as HTMLElement | null;
    if (!element || typeof document === 'undefined') return;
    const click = (event: MouseEvent) => {
      if (document.getSelection()?.isCollapsed === false) return;
      const frame = element.getBoundingClientRect();
      const x = event.clientX - frame.left;
      const y = event.clientY - frame.top;
      for (const [id, rects] of marksRef.current) {
        if (
          rects.some(
            (rect) =>
              x >= rect.left &&
              x <= rect.left + rect.width &&
              y >= rect.top &&
              y <= rect.top + rect.height,
          )
        ) {
          if (wideRef.current) marginRef.current?.onFocus(id);
          else marginRef.current?.onOpen(id);
          return;
        }
      }
    };
    element.addEventListener('click', click);
    return () => element.removeEventListener('click', click);
  }, []);

  const comment = React.useCallback(() => {
    if (!selected || !client || !scope) return;
    const passage = captureDocPassageV1({
      ref: {
        kind: 'doc',
        artifactId: props.artifactId,
        serverId: scope.serverId,
      },
      revision: props.revision,
      source: props.markdown,
      range: selected.range,
    });
    document.getSelection()?.removeAllRanges();
    setSelected(null);
    router.push(client.beginPassageComment(passage) as Href);
  }, [
    client,
    props.artifactId,
    props.markdown,
    props.revision,
    router,
    scope,
    selected,
  ]);

  // Each thread sits level with its passage, pushed down only as far as the thread above needs;
  // threads whose passage changed follow the placed ones.
  const cards = React.useMemo(() => {
    if (!wide || !margin) return [];
    let floor = 0;
    return margin.passages.map((passage) => {
      const rects = marks.get(passage.id);
      const want = rects?.[0]?.top ?? floor;
      const top = Math.max(want, floor);
      floor = top + (cardHeights.get(passage.id) ?? 0) + theme.space.s12;
      return { id: passage.id, top };
    });
  }, [cardHeights, margin, marks, theme.space.s12, wide]);
  const marginHeight = cards.length
    ? cards.at(-1)!.top + (cardHeights.get(cards.at(-1)!.id) ?? 0)
    : 0;
  const onCardLayout = React.useCallback(
    (id: string, event: LayoutChangeEvent) => {
      const height = Math.ceil(event.nativeEvent.layout.height);
      setCardHeights((previous) =>
        previous.get(id) === height
          ? previous
          : new Map(previous).set(id, height),
      );
    },
    [],
  );

  const placed = margin?.passages ?? [];
  return (
    <View
      ref={outer}
      style={[marginMode === 'inline' ? styles.row : null, marginMode === 'outside' ? { minHeight: marginHeight } : null]}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        const element = outer.current as unknown as HTMLElement | null;
        setLayout({ width, roomRight: element ? measureRoomRight(element) : 0 });
      }}
    >
      <View ref={container} style={[styles.frame, marginMode === 'inline' ? styles.body : null]}>
        {placed.map((passage) => {
          const rects = marks.get(passage.id);
          if (!rects || passage.location.state === 'detached') return null;
          const focused = margin?.focusedId === passage.id;
          const revised = passage.location.state === 'revised';
          return rects.map((rect, index) => (
            <View
              key={`${passage.id}:${index}`}
              testID={
                index === 0 ? `artifact:passage-mark:${passage.id}` : undefined
              }
              pointerEvents="none"
              style={[
                styles.mark,
                {
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                },
                revised
                  ? { backgroundColor: theme.colors.diff.added.background }
                  : { borderBottomColor: theme.colors.text.tertiary },
                focused
                  ? {
                      backgroundColor: revised
                        ? theme.colors.diff.added.background
                        : theme.colors.state.active.background,
                      borderBottomColor: theme.colors.state.active.border,
                    }
                  : null,
              ]}
            />
          ));
        })}
        {props.children}
        {selected && client && scope ? (
          <View
            style={[styles.anchor, { top: selected.top, left: selected.left }]}
          >
            <FloatingOverlay
              scrollEnabled={false}
              role="menu"
              surfaceChrome="theme"
            >
              <Pressable
                testID="artifact:passage-comment"
                accessibilityRole="button"
                accessibilityLabel={t('artifacts.browser.passage.comment')}
                // Pressing must not clear the selection before the passage is captured.
                onPressIn={(event) =>
                  (
                    event as unknown as { preventDefault?: () => void }
                  ).preventDefault?.()
                }
                onPress={comment}
                style={({ pressed }) => [
                  styles.action,
                  pressed
                    ? { backgroundColor: theme.colors.surface.pressedOverlay }
                    : null,
                ]}
              >
                <Icon
                  name="chat-circle"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
                <Text variant="label" emphasis="medium">
                  {t('artifacts.browser.passage.comment')}
                </Text>
              </Pressable>
            </FloatingOverlay>
          </View>
        ) : null}
      </View>
      {wide && margin ? (
        <View
          testID="artifact:passage-margin"
          style={[styles.margin, marginMode === 'outside'
            ? { position: 'absolute', top: 0, left: layout.width + theme.space.s24 }
            : { minHeight: marginHeight }]}
        >
          {cards.map((card) => (
            <View
              key={card.id}
              style={[styles.card, { top: card.top }]}
              onLayout={(event) => onCardLayout(card.id, event)}
            >
              {margin.renderCard(card.id)}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s32 },
  frame: { position: 'relative' },
  body: { flex: 1, minWidth: 0 },
  margin: { width: MARGIN_WIDTH, position: 'relative' },
  card: { position: 'absolute', left: 0, right: 0 },
  mark: {
    position: 'absolute',
    borderRadius: theme.borderRadius.sm,
    borderBottomWidth: 1.5,
    borderBottomColor: 'transparent',
  },
  anchor: { position: 'absolute', zIndex: 10 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    borderRadius: theme.borderRadius.md,
  },
}));
