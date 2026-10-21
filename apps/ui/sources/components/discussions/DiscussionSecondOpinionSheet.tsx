import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type {
  DiscussionSecondOpinionSourceV1,
  DiscussionSecondOpinionPreviewV1,
} from '@happier-dev/protocol/discussions/secondOpinion';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import {
  createDiscussionSecondOpinionController,
  type DiscussionSecondOpinionSnapshot,
} from './discussionSecondOpinionController';
import { executableParticipantOptionId, useExecutableParticipantSections } from './useExecutableParticipantSections';
import { useExecutableParticipantLabel } from '@/components/sessions/authoring/useExecutableParticipantLabel';

export type DiscussionSecondOpinionIntent = 'second_opinion' | 'discuss';

type SheetProps = Readonly<{
  source: Extract<DiscussionSecondOpinionSourceV1, { kind: 'session' }>;
  intent: DiscussionSecondOpinionIntent;
  /** The committed answer as the person read it; the quote leads the sheet before any preview. */
  sourceText: string;
  onClose: () => void;
  /** Opens the created Discussion through the hosting surface's navigation owner. */
  onOpenDiscussion: (href: string) => void;
}>;

const NO_SERVER_IDS: readonly string[] = [];

/**
 * L7: Get a second opinion / Discuss… on one committed answer. A dialog on wide screens and the
 * phone sheet on a phone (the shared modal chrome). The controller owns every effect; this view only
 * asks it for a read-only preview, shows who can read what, and asks only on the person's explicit
 * press. Returns a function that closes it.
 */
export function presentDiscussionSecondOpinion(
  props: Omit<SheetProps, 'onClose'>,
): () => void {
  let closed = false;
  const modalId = Modal.show({
    component: DiscussionSecondOpinionModal,
    props,
    chrome: {
      kind: 'card',
      header: 'none',
      title: sheetTitle(props.intent),
      phonePresentation: 'sheet',
      // The dialog keeps inside the window like the other share sheets: the reviewer list scrolls and the
      // footer's Ask stays in reach however many Sessions there are.
      scrollHost: 'bounded',
      bodyScroll: 'none',
      dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.92, size: 'md' },
    },
  });
  return () => {
    if (!closed) {
      closed = true;
      Modal.hide(modalId);
    }
  };
}

function DiscussionSecondOpinionModal(
  props: Omit<SheetProps, 'onClose'> & CustomModalInjectedProps,
) {
  return (
    <View style={styles.modalBody}>
      <DiscussionSecondOpinionForm {...props} onClose={props.onClose} />
    </View>
  );
}

function sheetTitle(intent: DiscussionSecondOpinionIntent): string {
  return intent === 'discuss'
    ? t('session.collaboration.discussion.secondOpinion.discussTitle')
    : t('session.collaboration.discussion.secondOpinion.title');
}

function DiscussionSecondOpinionForm(props: SheetProps) {
  const serverId = props.source.message.session.serverId;
  const serverIds = React.useMemo(() => [serverId], [serverId]);
  const bindings = useServerCredentialAccountScopeBindings(
    serverId ? serverIds : NO_SERVER_IDS,
  );
  const binding = [...bindings.values()][0] ?? null;
  if (!binding) {
    return (
      <SheetFrame intent={props.intent} subtitle={null} onClose={props.onClose}>
        <SurfaceStateCard
          size="line"
          kind="unavailable"
          title={t('session.collaboration.discussion.bindingUnavailable')}
        />
      </SheetFrame>
    );
  }
  return <BoundForm {...props} binding={binding} />;
}

function BoundForm(
  props: SheetProps &
    Readonly<{ binding: ServerCredentialAccountScopeBinding }>,
) {
  const { theme } = useUnistyles();
  const { binding } = props;
  const availability = useSessionCollaborationAvailability(
    binding.scope.serverId,
  );
  const sourceSession = props.source.message.session;
  const [sourceTitle] = useSessionDisplayTitles(
    React.useMemo(() => [sourceSession], [sourceSession]),
  );
  const discuss = props.intent === 'discuss';
  const [controller] = React.useState(() =>
    createDiscussionSecondOpinionController({
      scope: binding.scope,
      availability,
      source: props.source,
      draft: {
        title: discuss
          ? t(
              'session.collaboration.discussion.secondOpinion.discussDiscussionTitle',
            )
          : t('session.collaboration.discussion.secondOpinion.discussionTitle'),
        question: discuss
          ? ''
          : t('session.collaboration.discussion.secondOpinion.defaultQuestion'),
        reviewers: [],
      },
    }),
  );
  const snapshot = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [question, setQuestion] = React.useState(snapshot.draft.question);
  const [readinessSessionId, setReadinessSessionId] = React.useState<string | null>(null);
  const toggleReviewer = React.useCallback((selection: ExecutableParticipantSelectionV1) => {
    if (controller.toggleReviewer(selection, question) && controller.getSnapshot().draft.reviewers.length > 0) {
      void controller.preview();
    }
  }, [controller, question]);
  const candidateSource = useExecutableParticipantSections({
    accountLifetime: binding,
    enabled: !discuss,
    busy: snapshot.working || snapshot.submitted,
    readinessSessionId,
    onReadinessSessionChange: setReadinessSessionId,
    sessionsContext: t('session.collaboration.discussion.secondOpinion.yourSession'),
    onChoose: toggleReviewer,
  });
  const reviewers = React.useMemo(
    () => candidateSource.sections.flatMap(section => section.options)
      .filter(option => option.id !== `session:${sourceSession.sessionId}`),
    [candidateSource.sections, sourceSession.sessionId],
  );
  const selectedKeys = React.useMemo(
    () =>
      new Set(
        snapshot.draft.reviewers.map((reviewer) =>
          executableParticipantOptionId(reviewer.selection),
        ),
      ),
    [snapshot.draft.reviewers],
  );
  const reviewerLabel = useExecutableParticipantLabel(
    snapshot.draft.reviewers.length === 1 ? snapshot.draft.reviewers[0]!.selection : undefined,
    binding.scope.serverId,
  ) ?? null;

  // Discuss… previews at once (people only); a second opinion previews per chosen reviewer set.
  React.useEffect(() => {
    if (discuss) void controller.preview();
  }, [controller, discuss]);
  const ask = async (sourceAccess?: 'quote_only') => {
    const draft = snapshot.draft;
    const reviewersFor = sourceAccess
      ? draft.reviewers.map((reviewer) => ({ ...reviewer, sourceAccess }))
      : draft.reviewers;
    if (question !== draft.question || sourceAccess) {
      const shown = snapshot.preview?.preview
        ? JSON.stringify(snapshot.preview.preview)
        : null;
      controller.updateDraft({ ...draft, question, reviewers: reviewersFor });
      await controller.preview();
      const next = controller.getSnapshot().preview?.preview;
      // A quote-only ask changes what is shared, so it is the person's explicit choice; any
      // other preview change stops here and is shown before anything is asked.
      if (!sourceAccess && (!next || JSON.stringify(next) !== shown)) return;
    }
    await controller.ask();
  };

  const result = snapshot.result;
  const outcome = result?.outcome;
  const value = outcome?.kind === 'succeeded' ? outcome.value : null;
  const status = value && 'status' in value ? value.status : null;
  const done = snapshot.discussionHref !== null;
  const unavailable = status === 'unavailable';
  const preview = snapshot.preview?.preview ?? null;
  const reviewerPreview = preview?.reviewers[0] ?? null;
  const needsGrant =
    reviewerPreview !== null &&
    reviewerPreview.sourceAccess === 'read' &&
    reviewerPreview.missingSourceAccountIds.length > 0;
  // A reviewer outside the answer's audience is a gap the person can close by sharing the source
  // (the Ask grants, then rechecks before anything is disclosed); any other refusal stays one.
  const repairable = isRepairableSourceGap(reviewerPreview);
  const blocked =
    (reviewerPreview && !reviewerPreview.disclosure.ok && !repairable) ||
    (preview && !preview.discussionDisclosure.ok) ||
    (needsGrant && !reviewerPreview!.canGrantSource);
  const canAsk =
    !snapshot.working &&
    !done &&
    !unavailable &&
    !blocked &&
    preview !== null &&
    (discuss || (snapshot.draft.reviewers.length === 1 && question.trim().length > 0));

  const subtitle = sourceTitle
    ? t('session.collaboration.discussion.secondOpinion.subtitle', {
        session: sourceTitle,
      })
    : t('session.collaboration.discussion.secondOpinion.subtitleUntitled');
  const footer = done ? (
    <>
      <View style={styles.footerSpacer} />
      <RoundButton
        size="small"
        display="inverted"
        title={t('common.close')}
        onPress={props.onClose}
      />
      <RoundButton
        testID="second-opinion.open"
        size="small"
        title={t('session.collaboration.discussion.secondOpinion.open')}
        onPress={() => {
          props.onOpenDiscussion(snapshot.discussionHref!);
          props.onClose();
        }}
      />
    </>
  ) : (
    <>
      <RoundButton
        testID="second-opinion.cancel"
        size="small"
        display="inverted"
        title={t('common.cancel')}
        onPress={props.onClose}
      />
      <View style={styles.footerSpacer} />
      {needsGrant && !blocked && !discuss ? (
        <RoundButton
          testID="second-opinion.quote-only"
          size="small"
          display="inverted"
          title={t(
            'session.collaboration.discussion.secondOpinion.askQuoteOnly',
          )}
          disabled={!canAsk}
          action={() => ask('quote_only')}
        />
      ) : null}
      <RoundButton
        testID="second-opinion.ask"
        size="small"
        disabled={!canAsk}
        loading={snapshot.working && snapshot.submitted}
        title={
          discuss
            ? t('session.collaboration.discussion.create')
            : needsGrant
              ? t('session.collaboration.discussion.secondOpinion.shareAndAsk')
              : t('session.collaboration.discussion.secondOpinion.ask')
        }
        action={() =>
          discuss ? controller.discuss().then(() => undefined) : ask()
        }
      />
    </>
  );

  return (
    <SheetFrame
      intent={props.intent}
      subtitle={subtitle}
      onClose={props.onClose}
      footer={footer}
    >
      <ReplyQuote
        testID="second-opinion.quote"
        kind="message"
        source={{
          state: 'available',
          label:
            sourceTitle ??
            t('session.collaboration.discussion.secondOpinion.answer'),
          text: props.sourceText,
        }}
      />
      {done ? (
        <DoneLine
          snapshot={snapshot}
          discuss={discuss}
          reviewerLabel={reviewerLabel}
        />
      ) : null}
      {/* The question sits with the answer it is about; on a real Account the list of Sessions to ask runs
          long, and the question must not fall below it. */}
      {!discuss && !done ? (
        <FieldItem
          label={t('session.collaboration.discussion.secondOpinion.question')}
        >
          <FieldTextInput
            testID="second-opinion.question"
            accessibilityLabel={t(
              'session.collaboration.discussion.secondOpinion.question',
            )}
            value={question}
            onChangeText={setQuestion}
          />
        </FieldItem>
      ) : null}
      {!discuss && !done ? (
        <View>
          <View style={styles.groupRow}>
            <CollectionListGroupLabel
              title={t(
                'session.collaboration.discussion.secondOpinion.askGroup',
              )}
              presentation="menu"
            />
            <Text style={styles.groupNote} numberOfLines={1}>
              {t(
                'session.collaboration.discussion.secondOpinion.freshOpinionsHint',
              )}
            </Text>
          </View>
          {reviewers.length === 0 ? (
            <SurfaceStateCard
              size="line"
              kind={candidateSource.sessions.state ? 'empty' : 'loading'}
              title={
                candidateSource.sessions.state
                  ? t(
                      'session.collaboration.discussion.secondOpinion.noReviewers',
                    )
                  : t('session.collaboration.discussion.participants.loading')
              }
            />
          ) : (
            reviewers.map((candidate) => {
              const isSelected = selectedKeys.has(candidate.id);
              const isSessionChoice = candidate.id.startsWith('session:');
              return (
                <Item
                  key={candidate.id}
                  testID={candidate.id.startsWith('session:')
                    ? `second-opinion.reviewer:${candidate.id.slice('session:'.length)}` : candidate.testID}
                  density="compact"
                  showChevron={false}
                  showDivider={false}
                  selected={isSelected}
                  accessibilityRole={isSessionChoice ? 'checkbox' : 'button'}
                  accessibilityChecked={isSessionChoice ? isSelected : undefined}
                  accessibilityLabel={candidate.accessibilityLabel}
                  disabled={candidate.disabled}
                  leftElement={typeof candidate.icon === 'function' ? candidate.icon() : candidate.icon}
                  title={candidate.label}
                  subtitle={candidate.subtitle}
                  rightElement={
                    isSelected ? (
                      <Icon
                        name="check"
                        size={ICON_SIZE.sm}
                        color={theme.colors.text.primary}
                      />
                    ) : null
                  }
                  onHoverIn={candidate.onHighlight}
                  onFocus={candidate.onHighlight}
                  onPressIn={candidate.onPressIn}
                  onPress={candidate.onSelect}
                />
              );
            })
          )}
          {snapshot.draft.reviewers.map(reviewer => reviewer.selection.kind === 'model' ? (
            <SelectedModelReviewer key={reviewer.participantSlotId} selection={reviewer.selection}
              disabled={snapshot.working || snapshot.submitted} onRemove={() => toggleReviewer(reviewer.selection)} />
          ) : null)}
        </View>
      ) : null}
      {unavailable ? (
        <SurfaceStateCard
          size="line"
          kind="unavailable"
          title={t(
            'session.collaboration.discussion.secondOpinion.freshOpinionsUnavailableTitle',
          )}
          reason={t(
            'session.collaboration.discussion.secondOpinion.freshOpinionsUnavailableReason',
          )}
        />
      ) : null}
      {!done && preview ? (
        <ReadsSheet
          preview={preview}
          discuss={discuss}
          reviewerLabel={reviewerLabel}
          viewerAccountId={binding.scope.accountId}
          sourceTitle={sourceTitle}
        />
      ) : null}
      <ResultLine snapshot={snapshot} onRetry={() => void controller.retry()} />
    </SheetFrame>
  );
}

/** A chosen recipe is not an allocated Session; this is the retained selection, not another inventory. */
function SelectedModelReviewer(props: Readonly<{
  selection: Extract<ExecutableParticipantSelectionV1, { kind: 'model' }>;
  disabled: boolean;
  onRemove: () => void;
}>) {
  const { theme } = useUnistyles();
  const label = useExecutableParticipantLabel(props.selection, props.selection.launch.executionTarget.serverId);
  return <Item testID="second-opinion.selected-model" density="compact" showChevron={false} showDivider={false}
    selected accessibilityRole="checkbox" accessibilityChecked disabled={props.disabled}
    leftElement={<Icon name="sparkle" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
    title={label ?? t('session.collaboration.discussion.heldParticipant')}
    rightElement={<Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.primary} />}
    onPress={props.onRemove} />;
}

function SheetFrame(
  props: Readonly<{
    intent: DiscussionSecondOpinionIntent;
    subtitle: string | null;
    onClose: () => void;
    footer?: React.ReactNode;
    children: React.ReactNode;
  }>,
) {
  return (
    <View style={styles.form} testID="second-opinion.sheet">
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.heading} accessibilityRole="header">
            {sheetTitle(props.intent)}
          </Text>
          {props.subtitle ? (
            <Text style={styles.meta} numberOfLines={1}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>
      {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
    </View>
  );
}

/** "What they can read": one line per party, saying what each will be able to open. */
function ReadsSheet(
  props: Readonly<{
    preview: DiscussionSecondOpinionPreviewV1;
    discuss: boolean;
    reviewerLabel: string | null;
    viewerAccountId: string;
    sourceTitle: string | null;
  }>,
) {
  const reviewer = props.preview.reviewers[0];
  const name =
    props.reviewerLabel ??
    t('session.collaboration.discussion.heldParticipant');
  const session =
    props.sourceTitle ??
    t('session.collaboration.discussion.secondOpinion.thisSession');
  const rows: {
    key: string;
    icon: IconName;
    title: string;
    body: string;
    warning?: boolean;
  }[] = [];
  if (reviewer && !props.discuss) {
    if (!reviewer.disclosure.ok && !isRepairableSourceGap(reviewer)) {
      rows.push({
        key: 'reviewer',
        icon: 'warning',
        warning: true,
        title: t(
          'session.collaboration.discussion.secondOpinion.cannotAskTitle',
          { name },
        ),
        body: disclosureReason(reviewer.disclosure.reason),
      });
    } else if (reviewer.sourceAccess === 'quote_only') {
      rows.push({
        key: 'reviewer',
        icon: 'quotes',
        title: t(
          'session.collaboration.discussion.secondOpinion.quoteOnlyTitle',
          { name },
        ),
        body: t('session.collaboration.discussion.secondOpinion.quoteOnlyBody'),
      });
    } else if (reviewer.missingSourceAccountIds.length > 0) {
      rows.push({
        key: 'reviewer',
        icon: 'eye',
        title: t('session.collaboration.discussion.secondOpinion.grantTitle', {
          name,
        }),
        body: reviewer.canGrantSource
          ? t('session.collaboration.discussion.secondOpinion.grantBody', {
              name,
              session,
            })
          : t(
              'session.collaboration.discussion.secondOpinion.grantUnavailable',
            ),
      });
    } else {
      rows.push({
        key: 'reviewer',
        icon: 'eye',
        title:
          reviewer.runtimeAccountId === props.viewerAccountId
            ? t(
                'session.collaboration.discussion.secondOpinion.readsAsYouTitle',
                { name },
              )
            : t('session.collaboration.discussion.secondOpinion.readsTitle', {
                name,
              }),
        body: t(
          'session.collaboration.discussion.secondOpinion.readsAsYouBody',
        ),
      });
    }
  }
  const others = props.preview.discussionAudienceAccountIds.filter(
    (id) => id !== props.viewerAccountId,
  ).length;
  rows.push(
    props.preview.discussionDisclosure.ok
      ? {
          key: 'discussion',
          icon: 'users',
          title: t(
            'session.collaboration.discussion.secondOpinion.discussionTitleRow',
          ),
          body:
            others === 0
              ? t(
                  'session.collaboration.discussion.secondOpinion.discussionOnlyYou',
                )
              : t(
                  'session.collaboration.discussion.secondOpinion.discussionPeople',
                  { count: others },
                ),
        }
      : {
          key: 'discussion',
          icon: 'warning',
          warning: true,
          title: t(
            'session.collaboration.discussion.secondOpinion.discussionTitleRow',
          ),
          body: disclosureReason(props.preview.discussionDisclosure.reason),
        },
  );
  const { theme } = useUnistyles();
  return (
    <View>
      <CollectionListGroupLabel
        title={t('session.collaboration.discussion.secondOpinion.readsGroup')}
        presentation="menu"
      />
      <View style={styles.reads}>
        {rows.map((row, index) => (
          <View
            key={row.key}
            style={[styles.readRow, index > 0 ? styles.readDivider : null]}
          >
            <Icon
              name={row.icon}
              size={ICON_SIZE.sm}
              color={
                row.warning
                  ? theme.colors.state.warning.foreground
                  : theme.colors.text.secondary
              }
            />
            <View style={styles.readText}>
              <Text style={styles.readTitle}>{row.title}</Text>
              <Text style={styles.meta}>{row.body}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The reviewer can't read the answer yet, and sharing the source with them is allowed. */
export function isRepairableSourceGap(
  reviewer: Readonly<{
    disclosure: Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
    sourceAccess: string;
    missingSourceAccountIds: readonly string[];
    canGrantSource: boolean;
  }> | null,
): boolean {
  if (!reviewer || reviewer.sourceAccess !== 'read') return false;
  if (reviewer.missingSourceAccountIds.length === 0 || !reviewer.canGrantSource) return false;
  return reviewer.disclosure.ok || reviewer.disclosure.reason === 'destination_audience_broader';
}

function disclosureReason(reason: string): string {
  switch (reason) {
    case 'same_session':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.sameSession',
      );
    case 'destination_audience_broader':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.broader',
      );
    case 'destination_public':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.public',
      );
    case 'configurer_not_allowed':
    case 'destination_runtime_not_allowed':
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.notAllowed',
      );
    default:
      return t(
        'session.collaboration.discussion.secondOpinion.disclosure.unavailable',
      );
  }
}

function DoneLine(
  props: Readonly<{
    snapshot: DiscussionSecondOpinionSnapshot;
    discuss: boolean;
    reviewerLabel: string | null;
  }>,
) {
  return (
    <SurfaceStateCard
      size="line"
      kind="success"
      testID="second-opinion.done"
      title={
        props.discuss
          ? t('session.collaboration.discussion.secondOpinion.discussDone')
          : t('session.collaboration.discussion.secondOpinion.asked', {
              name:
                props.reviewerLabel ??
                t('session.collaboration.discussion.heldParticipant'),
            })
      }
      reason={
        props.discuss
          ? undefined
          : t('session.collaboration.discussion.secondOpinion.askedBody')
      }
    />
  );
}

function ResultLine(
  props: Readonly<{
    snapshot: DiscussionSecondOpinionSnapshot;
    onRetry: () => void;
  }>,
) {
  const outcome = props.snapshot.result?.outcome;
  if (!outcome || props.snapshot.working) return null;
  if (outcome.kind !== 'succeeded') {
    return (
      <SurfaceStateCard
        size="line"
        kind="error"
        testID="second-opinion.failed"
        title={t('session.collaboration.discussion.secondOpinion.failed')}
        diagnosticCode={outcome.kind === 'failed' ? outcome.errorCode : outcome.kind}
        action={
          props.snapshot.submitted
            ? {
                label: t('session.collaboration.discussion.retry'),
                onPress: props.onRetry,
              }
            : undefined
        }
      />
    );
  }
  const value = outcome.value;
  if (!('status' in value)) return null;
  if (value.status === 'pending') {
    return (
      <SurfaceStateCard
        size="line"
        kind="warning"
        testID="second-opinion.pending"
        title={t('session.collaboration.discussion.secondOpinion.pending')}
        diagnosticCode={value.errorCode}
        action={{
          label: t('session.collaboration.discussion.retry'),
          onPress: props.onRetry,
        }}
      />
    );
  }
  if (value.status === 'preview_changed') {
    return (
      <SurfaceStateCard
        size="line"
        kind="warning"
        testID="second-opinion.changed"
        title={t(
          'session.collaboration.discussion.secondOpinion.previewChanged',
        )}
      />
    );
  }
  return null;
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
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
  },
  groupNote: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  reads: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
  },
  readRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s10,
    padding: theme.space.s12,
  },
  readDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  readText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  readTitle: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
  footerSpacer: { flex: 1 },
  modalBody: {
    width: '100%',
    flexShrink: 1,
  },
}));
