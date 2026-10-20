import * as React from 'react';
import { Animated } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { WorkspaceFileEditorHeaderModel } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorHeaderModel';
import { t } from '@/text';

/** The editor's one presentation lifetime (P4-I6): Saved shows for 2 s after a save lands, then Editing returns. */
const SAVED_MOMENT_MS = 2_000;

type PillWord = 'editing' | 'unsaved' | 'saving' | 'saved';

export function resolveFileEditorPillWord(
  editor: Pick<WorkspaceFileEditorHeaderModel, 'status'>,
  savedMoment: boolean,
): PillWord {
  if (editor.status === 'saving') return 'saving';
  if (editor.status === 'dirty' || editor.status === 'conflict')
    return 'unsaved';
  return savedMoment ? 'saved' : 'editing';
}

function useSavedMoment(savedAtMs: number | null): boolean {
  const [now, setNow] = React.useState(() => Date.now());
  const remaining = savedAtMs === null ? 0 : savedAtMs + SAVED_MOMENT_MS - now;
  React.useEffect(() => {
    if (savedAtMs === null) return;
    setNow(Date.now());
    const timeout = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, savedAtMs + SAVED_MOMENT_MS - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [savedAtMs]);
  return remaining > 0;
}

/**
 * Editing · Unsaved · Saving · Saved (files lab ED1u, ED1s): the editor's state beside the title. The word
 * cross-fades in place; under reduced motion it changes at once.
 */
export const FileEditorStatusPill = React.memo(function FileEditorStatusPill(
  props: Readonly<{
    editor: WorkspaceFileEditorHeaderModel;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const savedMoment = useSavedMoment(props.editor.savedAtMs);
  const word = resolveFileEditorPillWord(props.editor, savedMoment);
  const opacity = React.useRef(new Animated.Value(1)).current;
  const previousWord = React.useRef(word);
  React.useEffect(() => {
    if (previousWord.current === word) return;
    previousWord.current = word;
    if (reducedMotion) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: motionTokens.guardMoment.wordCrossFadeMs,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, reducedMotion, word]);
  const label =
    word === 'saving'
      ? t('files.editing.statusSaving')
      : word === 'unsaved'
        ? t('files.editing.statusUnsaved')
        : word === 'saved'
          ? t('files.editing.statusSaved')
          : t('files.editing.statusEditing');
  const leading =
    word === 'saving' ? (
      <ActivitySpinner
        size={10}
        color={theme.colors.text.secondary}
        animationEnabled={!reducedMotion}
      />
    ) : word === 'saved' ? (
      <Icon name="check" size={11} color={theme.colors.text.secondary} />
    ) : undefined;
  return (
    <Animated.View
      style={{ opacity }}
      accessibilityLiveRegion="polite"
      aria-live="polite"
    >
      <StatusPill
        testID="file-editor-status-pill"
        variantTestID={`file-editor-status-${word}`}
        variant="neutral"
        shape="capsule"
        labelVariant="phrase"
        label={label}
        leading={leading}
        hideDot={word !== 'unsaved'}
      />
    </Animated.View>
  );
});
