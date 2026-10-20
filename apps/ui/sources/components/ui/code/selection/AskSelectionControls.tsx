import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionActionBar } from '@/components/ui/selection/SelectionActionBar';
import { Icon } from '@/components/ui/icons/Icon';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import { SelectionToolbar } from './SelectionToolbar';
import { useAskSelection, type UseAskSelectionInput } from './useAskSelection';

export type AskSelectionControlsProps = UseAskSelectionInput &
  Readonly<{
    /** Comment opens this surface's own inline composer; omit where the surface has none. */
    commentEnabled?: boolean;
    /** The surface's own Comment for the selected lines (opens its inline composer); implies Comment. */
    onCommentSelection?: (range: Readonly<{ startLine: number; endLine: number }>) => void;
    /** Clears the source selection (phone ✕). */
    onDismissSelection?: () => void;
    testID?: string;
  }>;

/**
 * The rendered Ask controls for one selection source: the floating toolbar on desktop, the selection
 * bar on a phone. One `useAskSelection` owns the operation; this binds its result to chrome only.
 */
export function AskSelectionControls(
  props: AskSelectionControlsProps,
): React.ReactElement | null {
  const { commentEnabled, onCommentSelection, onDismissSelection, testID, ...input } = props;
  const ask = useAskSelection(input);
  const phone = useDeviceType() === 'phone';
  const selection = ask.selection;
  // Once the person asked or commented, the toolbar steps back until the selection changes (lab A2:
  // the selection stays visible, the question is in the composer now).
  const selectionKey = selection
    ? `${selection.startLine}:${selection.endLine}:${selection.text}`
    : null;
  const [actedOnKey, setActedOnKey] = React.useState<string | null>(null);
  const visible =
    props.active !== false &&
    selection !== null &&
    selection.collapsed !== true &&
    selection.text.length > 0 &&
    selectionKey !== actedOnKey;
  // Without a session the operation still has a destination (a side run or a new session), so Ask stays.
  const onAsk = React.useCallback(() => {
    setActedOnKey(selectionKey);
    return ask.ask();
  }, [ask.ask, selectionKey]);
  const onComment = React.useMemo(() => {
    if (onCommentSelection) {
      return () => {
        const current = ask.selection;
        setActedOnKey(selectionKey);
        if (current) onCommentSelection({ startLine: current.startLine, endLine: current.endLine });
      };
    }
    if (!commentEnabled || !ask.canComment) return null;
    return () => {
      setActedOnKey(selectionKey);
      return ask.comment();
    };
  }, [ask.canComment, ask.comment, ask.selection, commentEnabled, onCommentSelection, selectionKey]);
  const menuItems = React.useMemo(() => ask.menuItems.map((item) => ({
    ...item,
    run: () => {
      setActedOnKey(selectionKey);
      return item.run();
    },
  })), [ask.menuItems, selectionKey]);
  if (phone) {
    const lineCount = selection
      ? selection.endLine - selection.startLine + 1
      : 0;
    return (
      <SelectionActionBar
        visible={visible}
        label={t('files.askSelection.lineCount', { count: lineCount })}
        actions={[
          {
            id: 'ask',
            label: t('files.askSelection.ask'),
            emphasis: 'primary',
            onPress: onAsk,
            testID: 'selection-bar-ask',
            renderIcon: (color) => (
              <Icon name="sparkle" size={16} color={color} />
            ),
          },
          ...(onComment
            ? [
                {
                  id: 'comment',
                  label: t('files.askSelection.comment'),
                  onPress: onComment,
                  testID: 'selection-bar-comment',
                },
              ]
            : []),
          {
            id: 'copy',
            label: t('files.askSelection.copy'),
            onPress: ask.copy,
            testID: 'selection-bar-copy',
          },
          ...menuItems.map((item) => ({
            id: item.id,
            label: item.label,
            onPress: item.run,
            testID: `selection-bar-${item.id}`,
          })),
        ]}
        dismiss={{
          label: t('common.close'),
          onPress: () => onDismissSelection?.(),
          testID: 'selection-bar-dismiss',
        }}
        style={styles.phoneBar}
        testID={testID ? `${testID}-bar` : 'selection-bar'}
      />
    );
  }
  return (
    <SelectionToolbar
      anchor={visible ? (selection?.rect ?? null) : null}
      onAsk={onAsk}
      askMenuItems={menuItems}
      onComment={onComment}
      onCopy={ask.copy}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  phoneBar: {
    position: 'absolute',
    left: theme.space.s16,
    right: theme.space.s16,
    bottom: theme.space.s16,
  },
}));
