import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  FileReviewNoteOperationV1,
  FileReviewNoteV1,
} from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';
import { storage } from '@/sync/domains/state/storage';
import { useSessionSelector } from '@/sync/store/hooks';
import { t } from '@/text';
import { resolveSessionTurnNumber } from './sessionTurnNumber';

type Turns =
  | readonly Readonly<{ turnId: string; startedAt: number }>[]
  | null
  | undefined;

function operationText(note: FileReviewNoteOperationV1, turns: Turns): string {
  const paths = note.paths.join(', ');
  const number = resolveSessionTurnNumber(turns, note.turnId);
  const turn = number === null ? null : t('hunkReview.turn', { turn: number });
  const inTurn = (text: string) => (turn ? `${text} (${turn})` : text);
  if (note.action === 'discard')
    return inTurn(
      t('fileReviewNote.discard', { paths, count: note.changeCount ?? null }),
    );
  if (note.action === 'restore')
    return turn
      ? t('fileReviewNote.restoreBeforeTurn', { paths, turn })
      : t('fileReviewNote.restore', { paths });
  if (note.undoes === 'discard')
    return inTurn(t('fileReviewNote.undoDiscard', { paths }));
  if (note.undoes === 'restore')
    return inTurn(t('fileReviewNote.undoRestore', { paths }));
  return inTurn(t('fileReviewNote.undo', { paths }));
}

/** One compact line per review action, naming the turn by its place in the Session. */
export function fileReviewNoteText(
  note: FileReviewNoteV1,
  turns: Turns,
): string {
  return note.action === 'mixed'
    ? note.operations
        .map((operation) => operationText(operation, turns))
        .join('; ')
    : operationText(note, turns);
}

/** Find projection reads the same turn order the line renders, without subscribing. */
export function projectFileReviewNoteText(
  note: FileReviewNoteV1,
  sessionId: string | undefined,
): string {
  const turns = sessionId
    ? storage.getState().sessions[sessionId]?.sessionTurns?.turns
    : null;
  return fileReviewNoteText(note, turns);
}

const selectTurns = (
  session: Readonly<{
    sessionTurns?: Readonly<{ turns: Turns }> | null;
  }> | null,
) => session?.sessionTurns?.turns ?? null;

/** The transcript note after a Discard, Restore or Undo (lab ade-shell CK1 C2): glyph + one quiet line. */
export function FileReviewNoteLine(
  props: Readonly<{
    note: FileReviewNoteV1;
    sessionId: string;
    serverId?: string | null;
  }>,
) {
  const { theme } = useUnistyles();
  const turns = useSessionSelector(
    props.sessionId,
    props.serverId,
    selectTurns,
  );
  const first =
    props.note.action === 'mixed' ? props.note.operations[0] : props.note;
  const glyph =
    first?.action === 'restore' || first?.undoes === 'restore'
      ? 'clock-counter-clockwise'
      : 'arrow-arc-left';
  return (
    <View testID="file-review-note" style={styles.row}>
      <Icon
        name={glyph}
        size={ICON_SIZE.xs}
        color={theme.colors.text.secondary}
      />
      <StructuredFindText
        blockId="structured-file-review-note"
        variant="meta"
        style={[styles.text, { color: theme.colors.text.secondary }]}
        text={fileReviewNoteText(props.note, turns)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  text: {
    flexShrink: 1,
  },
}));
