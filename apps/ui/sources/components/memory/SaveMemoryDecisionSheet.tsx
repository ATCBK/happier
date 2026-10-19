import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HAPPIER_PAGE_METRICS,
  resolveHappierFutureLocalDateTime,
  toHappierLocalDateTimeDraft,
  type HappierLocalDateTimeDraft,
} from '@happier-dev/plugin-ui/presentation';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { MemoryDecisionSourceErrorCodeV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { LocalDateTimeEditor } from '@/components/ui/dateTime/LocalDateTimeEditor';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useSessionSelector } from '@/sync/store/hooks';
import {
  memoryDocumentActions,
  readMemoryActionOutcome,
  readMemoryDuplicateReview,
  readMemoryCreationReceipt,
  type MemoryCreationReceipt,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';

import {
  leadingCandidateId,
  MemoryDuplicateChoice,
  type DuplicateChoiceKind,
  type DuplicateReview,
} from './MemoryDocumentBody';

/** A fresh date expiry starts a month out; the person picks the real day. */
const INITIAL_EXPIRY_OFFSET_MS = 30 * 24 * 60 * 60 * 1000;

/** What opens the sheet: the exact committed message, and what to prefill from it. */
export type SaveMemoryDecisionSeed = Readonly<{
  sourceMessageRef: CoordinationMessageRefV1;
  /** The decision as one line; the person edits it before saving. */
  text: string;
  reason?: string;
}>;

type FormProps = Readonly<{
  seed: SaveMemoryDecisionSeed;
  onClose: () => void;
  onSaved: () => void;
  /** The saved document can be opened/attached through the existing Context flow. */
  onCreatedMemory?: (receipt: MemoryCreationReceipt) => void;
}>;

type Notice =
  | 'pending'
  | 'conflict'
  | 'refused'
  | 'disclosure'
  | 'sourceUnavailable'
  | null;
type Expiry = 'never' | 'date';

/** First line of the answer as the decision, the rest as its reason; both stay editable. */
export function seedMemoryDecisionFromMessage(
  sourceMessageRef: CoordinationMessageRefV1,
  message: string,
): SaveMemoryDecisionSeed {
  const trimmed = message.trim();
  const [first = '', ...rest] = trimmed.split(/\r?\n/);
  return {
    sourceMessageRef,
    text: first
      .replace(/^[#>*\-\s]+/, '')
      .replace(/\*\*/g, '')
      .trim(),
    reason: rest.join('\n').trim(),
  };
}

/** The server's own source refusals say why nothing was saved; any other refusal stays the generic one. */
function readMemoryDecisionSourceRefusal(errorCode: unknown): 'disclosure' | 'sourceUnavailable' | null {
  const code = MemoryDecisionSourceErrorCodeV1Schema.safeParse(errorCode);
  if (!code.success) return null;
  return code.data === 'memory_decision_disclosure_denied'
    ? 'disclosure'
    : code.data === 'memory_decision_source_unavailable'
      ? 'sourceUnavailable'
      : null;
}

/**
 * Save as decision (lab K2 `S`/`Sd`, C6 §5): the decision, its reason, the exact message it was decided
 * in and an expiry (Never or a date). It saves through `memory.decision.save`: a Session's message to that
 * Session's own memory, a Discussion's message to the person's own memory; a person's save stamps their own approval. When that memory already has something similar, the same
 * form leads with it and asks Update / Replace / Keep both, keeping everything typed.
 */
export function SaveMemoryDecisionForm(props: FormProps) {
  const { seed } = props;
  const source = seed.sourceMessageRef;
  const sessionSource = source.kind === 'session' ? source.session : null;
  const serverId = sessionSource?.serverId ?? (source.kind === 'discussion' ? source.discussion.serverId : '');
  const sessionId = sessionSource?.sessionId ?? '';
  const sessionMetadataVersion = useSessionSelector(
    sessionId,
    serverId,
    (session) => session?.metadataVersion ?? null,
  );
  // A Session's save needs its current metadata revision; a Discussion's goes to the person's memory.
  const ready = source.kind === 'discussion' || sessionMetadataVersion !== null;
  const [text, setText] = React.useState(seed.text);
  const [reason, setReason] = React.useState(seed.reason ?? '');
  const [expiry, setExpiry] = React.useState<Expiry>('never');
  const [nowMs] = React.useState(() => Date.now());
  const [expiryDraft, setExpiryDraft] =
    React.useState<HappierLocalDateTimeDraft>(() =>
      toHappierLocalDateTimeDraft(new Date(nowMs + INITIAL_EXPIRY_OFFSET_MS)),
    );
  const [review, setReview] = React.useState<DuplicateReview | null>(null);
  const [choice, setChoice] = React.useState<DuplicateChoiceKind>('replace');
  const [candidateId, setCandidateId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [busy, setBusy] = React.useState(false);
  const [creationReceipt, setCreationReceipt] = React.useState<MemoryCreationReceipt | null>(null);
  const [controller] = React.useState(() => new AbortController());
  React.useEffect(() => () => controller.abort(), [controller]);
  const expiresAtMs =
    expiry === 'date'
      ? resolveHappierFutureLocalDateTime(expiryDraft, nowMs)
      : null;
  const canSave =
    !busy &&
    creationReceipt === null &&
    notice !== 'pending' &&
    text.trim().length > 0 &&
    reason.trim().length > 0 &&
    ready &&
    (expiry === 'never' || expiresAtMs !== null);

  const save = React.useCallback(async () => {
    if (!canSave) return;
    setBusy(true);
    setNotice(null);
    const choiceFactId = review
      ? (candidateId ?? leadingCandidateId(review))
      : null;
    try {
      const draft = {
          text: text.trim(),
          reason: reason.trim(),
          sourceMessageRef: source,
          ...(expiresAtMs !== null ? { expiresAtMs } : {}),
          ...(review
            ? {
                reviewedTarget: {
                  ref: review.ref,
                  expectedRevision: review.revision,
                },
                duplicateChoice:
                  choice === 'keep_both' || choiceFactId === null
                    ? {
                        kind: 'keep_both' as const,
                        expectedRevision: review.revision,
                      }
                    : {
                        kind: choice,
                        factId: choiceFactId,
                        expectedRevision: review.revision,
                      },
              }
            : {}),
      };
      const result =
        sessionSource !== null && sessionMetadataVersion !== null
          ? await memoryDocumentActions.saveDecisionInSession(
              {
                sessionId: sessionSource.sessionId,
                serverId: sessionSource.serverId,
                expectedMetadataRevision: sessionMetadataVersion,
              },
              draft,
              controller.signal,
            )
          : await memoryDocumentActions.saveDecisionInScope(
              { scope: 'account' },
              draft,
              serverId,
              controller.signal,
            );
      if (controller.signal.aborted) return;
      const found = readMemoryDuplicateReview(result);
      if (found) {
        setReview(found);
        setCandidateId(leadingCandidateId(found));
        return;
      }
      const outcome = readMemoryActionOutcome(result);
      const sourceRefusal = result.ok ? null : readMemoryDecisionSourceRefusal(result.errorCode);
      if (sourceRefusal) {
        setNotice(sourceRefusal);
        return;
      }
      const receipt = readMemoryCreationReceipt(result);
      if (receipt) {
        setCreationReceipt(receipt);
        props.onCreatedMemory?.(receipt);
      }
      if (outcome === 'applied') props.onSaved();
      else setNotice(outcome === 'review' || outcome === 'saved_unattached' ? null : outcome);
    } catch (error) {
      if (!controller.signal.aborted) {
        setNotice(
          readMemoryDecisionSourceRefusal(
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
          ) ?? 'refused',
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [
    canSave,
    candidateId,
    choice,
    controller,
    expiresAtMs,
    props,
    reason,
    review,
    serverId,
    sessionMetadataVersion,
    sessionSource,
    source,
    text,
  ]);

  const expiryOptions = React.useMemo(
    (): ReadonlyArray<SegmentedChoiceOption<Expiry>> => [
      { id: 'never', label: t('memoryContext.memory.sheetExpiresNever') },
      { id: 'date', label: t('memoryContext.memory.sheetExpiresOnDate') },
    ],
    [],
  );
  const saveLabel = !review
    ? t('memoryContext.memory.sheetSave')
    : choice === 'update'
      ? t('memoryContext.memory.sheetSaveUpdate')
      : choice === 'replace'
        ? t('memoryContext.memory.sheetSaveReplace')
        : t('memoryContext.memory.duplicateKeepBoth');

  return (
    <View testID="save-memory-decision" style={styles.form}>
      <View style={styles.header}>
        <Icon name="check-circle" />
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            {t('memoryContext.memory.sheetTitle')}
          </Text>
          <Text style={styles.meta}>
            {t(
              sessionSource
                ? 'memoryContext.memory.sheetTarget'
                : 'memoryContext.memory.sheetTargetPerson',
            )}
          </Text>
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {notice === 'pending' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.pending"
            busy
            reason={t('memoryContext.memory.pending')}
          />
        ) : notice === 'conflict' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.conflict"
            tone="warning"
            reason={t('memoryContext.memory.sheetConflict')}
          />
        ) : notice === 'disclosure' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.disclosure"
            tone="warning"
            reason={t('memoryContext.memory.sheetDisclosureDenied')}
          />
        ) : notice === 'sourceUnavailable' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.sourceUnavailable"
            tone="warning"
            reason={t('memoryContext.memory.sheetSourceUnavailable')}
          />
        ) : notice === 'refused' ? (
          <SurfaceFreshnessLine
            testID="save-memory-decision.refused"
            tone="warning"
            reason={t('memoryContext.memory.sheetRefused')}
          />
        ) : null}
        {review ? (
          <MemoryDuplicateChoice
            testID="save-memory-decision.duplicate"
            review={review}
            newText={text}
            candidateId={candidateId}
            onCandidateChange={setCandidateId}
            choice={choice}
            onChoiceChange={setChoice}
            disabled={busy}
          />
        ) : null}
        <FieldItem label={t('memoryContext.memory.sheetDecisionLabel')}>
          <FieldTextInput
            testID="save-memory-decision.text"
            accessibilityLabel={t('memoryContext.memory.sheetDecisionLabel')}
            value={text}
            onChangeText={setText}
            autoFocus
            selectTextOnFocus
          />
        </FieldItem>
        <FieldItem label={t('memoryContext.memory.sheetReasonLabel')}>
          <FieldTextInput
            testID="save-memory-decision.reason"
            accessibilityLabel={t('memoryContext.memory.sheetReasonLabel')}
            placeholder={t('memoryContext.memory.sheetReasonPlaceholder')}
            value={reason}
            onChangeText={setReason}
            multiline
            minLines={2}
          />
        </FieldItem>
        <View style={styles.source}>
          <Icon name="quotes" size={14} />
          <Text style={styles.meta}>
            {t(
              sessionSource
                ? 'memoryContext.memory.sheetSource'
                : 'memoryContext.memory.sheetSourceMessage',
            )}
          </Text>
        </View>
        <SegmentedChoiceItem<Expiry>
          title={t('memoryContext.memory.sheetExpires')}
          options={expiryOptions}
          value={expiry}
          onChange={setExpiry}
          testIDPrefix="save-memory-decision.expiry"
          accessoryLayout="adaptive"
          showDivider={false}
          disabled={busy}
        />
        {expiry === 'date' ? (
          <LocalDateTimeEditor
            nowMs={nowMs}
            value={expiryDraft}
            onChange={setExpiryDraft}
            testIDPrefix="save-memory-decision.expiresAt"
            labels={{
              date: t('memoryContext.memory.sheetExpiryDate'),
              time: t('memoryContext.memory.sheetExpiryTime'),
              pastInstant: t('memoryContext.memory.sheetExpiryPast'),
            }}
          />
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        <Text style={[styles.meta, styles.approval]} numberOfLines={1}>
          {t('memoryContext.memory.sheetApprovedByYouNow')}
        </Text>
        <RoundButton
          testID="save-memory-decision.cancel"
          size="small"
          display="inverted"
          title={notice === 'pending' ? t('common.close') : t('common.cancel')}
          onPress={props.onClose}
        />
        <RoundButton
          testID="save-memory-decision.save"
          size="small"
          title={saveLabel}
          disabled={!canSave}
          loading={busy}
          action={save}
        />
      </View>
    </View>
  );
}

function SaveMemoryDecisionModal(
  props: Omit<FormProps, 'onClose'> &
    Readonly<{ onCancel: () => void }> &
    CustomModalInjectedProps,
) {
  return (
    <SaveMemoryDecisionForm
      seed={props.seed}
      onCreatedMemory={props.onCreatedMemory}
      onSaved={() => {
        props.onSaved();
        props.onClose();
      }}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
    />
  );
}

/**
 * The panel anchored to the action that opened it on web, the phone sheet on native. Message action
 * menus and C1's answered lasting question ("Remember this") open this same sheet with their seed.
 */
export function SaveMemoryDecisionSheet(
  props: FormProps & Readonly<{ anchorRef: React.RefObject<View | null> }>,
) {
  const native = Platform.OS !== 'web';
  React.useEffect(() => {
    if (!native) return;
    const modalId = Modal.show({
      component: SaveMemoryDecisionModal,
      props: {
        seed: props.seed,
        onSaved: props.onSaved,
        onCreatedMemory: props.onCreatedMemory,
        onCancel: props.onClose,
      },
      onRequestClose: props.onClose,
      chrome: {
        kind: 'card',
        header: 'none',
        title: t('memoryContext.memory.sheetTitle'),
        phonePresentation: 'sheet',
      },
    });
    return () => Modal.hide(modalId);
  }, [native, props.seed.sourceMessageRef.messageId]);
  if (native) return null;
  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      placement="auto-vertical"
      maxWidthCap={HAPPIER_PAGE_METRICS.dialogWidthPx.default}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
      onRequestClose={props.onClose}
    >
      {({ maxHeight }) => (
        <FloatingOverlay surfaceChrome="theme" maxHeight={maxHeight}>
          <View style={[styles.popoverBody, { maxHeight }]}>
            <SaveMemoryDecisionForm
              seed={props.seed}
              onCreatedMemory={props.onCreatedMemory}
              onClose={props.onClose}
              onSaved={props.onSaved}
            />
          </View>
        </FloatingOverlay>
      )}
    </Popover>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    paddingVertical: theme.space.s16,
    gap: theme.space.s12,
    flexShrink: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
  },
  headerText: { flex: 1, minWidth: 0 },
  heading: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: theme.space.s16, gap: theme.space.s12 },
  source: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
  approval: { flex: 1, minWidth: 0 },
  popoverBody: {
    width: HAPPIER_PAGE_METRICS.dialogWidthPx.default,
    maxWidth: '100%',
    // A taller review shrinks the form's scroll area; the footer actions stay inside the overlay.
    flexShrink: 1,
    minHeight: 0,
  },
}));
