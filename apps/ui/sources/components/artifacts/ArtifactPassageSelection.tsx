import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';

import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import { mapRenderedSelectionToMarkdownSource } from '@/components/markdown/rendering/markdownSelectionSource';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useArtifactActionsClient } from './artifactActionsClient';

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;
type Selected = Readonly<{
  range: Readonly<{ start: number; end: number }>;
  top: number;
  left: number;
}>;

/** The Comment affordance sits above the selection's middle, kept inside the body column. */
const AFFORDANCE_HALF_WIDTH = 56;
const AFFORDANCE_LIFT = 44;

/**
 * Select a passage in a Doc, then Comment (C5 lab K1-S): the selection is placed in the canonical
 * Markdown source by the Markdown owner's projection (never by searching for the quote), captured as
 * a passage at the revision being read, and opens the one Discussion composer with that passage.
 * Web reads the browser selection; elsewhere the body renders unchanged.
 */
export function ArtifactPassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision | null;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  if (Platform.OS !== 'web' || props.revision === null)
    return <>{props.children}</>;
  return <WebPassageSelection {...props} revision={props.revision} />;
}

function WebPassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const client = useArtifactActionsClient();
  const scope = useActiveServerAccountScope();
  const container = React.useRef<View>(null);
  const [selected, setSelected] = React.useState<Selected | null>(null);

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

  return (
    <View ref={container} style={styles.frame}>
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
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: { position: 'relative' },
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
