import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DocEditProposalV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DocEditProposalDispositionV1 } from '@happier-dev/protocol/discussions/models';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Text } from '@/components/ui/text/Text';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { readViewportClass } from '@/utils/platform/useViewportClass';
import type { ArtifactActionsClient } from './artifactActionsClient';
import { artifactViewRoute } from './artifactBrowserModel';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;
type Currency = 'unknown' | 'current' | 'movedOn';
type Busy = 'accept' | 'decline' | 'undo' | null;
type DocReadValue = Extract<Awaited<ReturnType<ArtifactActionsClient['readDoc']>>, { ok: true }>['value'];
export type AdmittedDocRead = Readonly<{ status: 'loading' | 'unavailable' }>
  | Readonly<{ status: 'ready'; value: DocReadValue }>;

/** The Action's typed refusal when the Doc is no longer at the revision the person reviewed. */
const VERSION_MISMATCH = 'version_mismatch';

const sameRevision = (left: Revision, right: Revision) =>
  left.headerVersion === right.headerVersion &&
  left.bodyVersion === right.bodyVersion;

/**
 * A suggested edit in its passage thread (C5 L8 / lab K1): the reviewed before/after through the one
 * prose diff owner, why it was suggested, the revision it is based on, and Accept / Decline for the
 * person reading it. The stored disposition (C3) is the authority for accepted/declined; a decision
 * shows as settled only once the Home acknowledges it, and a stale basis says nothing was applied.
 */
export function ArtifactEditProposal(
  props: Readonly<{
    testID?: string;
    client: ArtifactActionsClient;
    /** Present on a Doc view even while loading/unavailable; absent only for a standalone thread. */
    docRead?: AdmittedDocRead;
    /** The committed proposal message; `null` while the post is still local. */
    proposalRef: DiscussionMessageRefV1 | null;
    proposal: DocEditProposalV1;
    disposition: DocEditProposalDispositionV1 | undefined;
    viewerAccountId: string | null;
    resolveAccountLabel: (accountId: string) => string | null;
    /** Who suggested the edit, as the thread names and mentions them; Ask to redo addresses them. */
    proposer?: ProposalAuthor | null;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const router = useRouter();
  const styles = stylesheet;
  const testID = props.testID ?? 'artifact-edit-proposal';
  const { client, proposal, proposalRef } = props;
  const artifactId = proposal.target.ref.artifactId;
  const base = proposal.baseRevision;

  // The Home's acknowledgement stands in until the thread's own disposition catches up with it.
  const [acknowledged, setAcknowledged] =
    React.useState<DocEditProposalDispositionV1 | null>(null);
  const disposition =
    props.disposition && props.disposition.state !== 'open'
      ? props.disposition
      : (acknowledged ?? props.disposition ?? { state: 'open' as const });
  // The Doc's revision as the app already holds it (kept current by sync, as the Doc page reads it): when
  // another edit lands, this suggestion's currency is read again rather than left as it was on mount.
  const docRevisionKey = getStorage()((state) => {
    const stored = state.artifacts[artifactId];
    return stored ? `${stored.headerVersion}.${stored.bodyVersion ?? ''}` : '';
  });
  const [standaloneCurrency, setCurrency] = React.useState<Currency>('unknown');
  const admitted = props.docRead?.status === 'ready'
    && props.docRead.value.ref.artifactId === artifactId
    && areServerProfileIdentifiersEquivalent(props.docRead.value.ref.serverId, proposalRef?.discussion.serverId)
      ? props.docRead.value.artifact : null;
  const currency: Currency = props.docRead === undefined ? standaloneCurrency
    : admitted ? sameRevision(admitted.revision, base) ? 'current' : 'movedOn' : 'unknown';
  const [refusal, setRefusal] = React.useState<
    'movedOn' | 'cantEdit' | 'failed' | null
  >(null);
  const [busy, setBusy] = React.useState<Busy>(null);
  const [undo, setUndo] = React.useState<
    | Readonly<{ state: 'done'; revision: Revision }>
    | Readonly<{ state: 'conflict' | 'failed' }>
    | null
  >(null);

  React.useEffect(() => {
    if (props.docRead !== undefined || disposition.state !== 'open') return;
    let live = true;
    setCurrency('unknown');
    // The Doc lives in this thread's Home (C5 §4), which the client is already bound to; its stored
    // label may be another device's name for that Home, so the read names only the document.
    void client.readDoc({ ref: { kind: 'doc', artifactId } }).then((read) => {
      if (!live) return;
      // A reader is told who can accept up front rather than after pressing Accept.
      if (read.ok && read.value.artifact.access === 'view') setRefusal('cantEdit');
      setCurrency(
        read.ok
          ? sameRevision(read.value.artifact.revision, base)
            ? 'current'
            : 'movedOn'
          : 'unknown',
      );
    });
    return () => {
      live = false;
    };
  }, [client, artifactId, base, disposition.state, docRevisionKey, props.docRead]);

  const decide = React.useCallback(
    async (kind: 'accept' | 'decline') => {
      if (!proposalRef || busy) return;
      setBusy(kind);
      setRefusal(null);
      const outcome =
        kind === 'accept'
          ? await client.acceptEdit({ proposalRef, expectedRevision: base })
          : await client.declineEdit({ proposalRef });
      setBusy(null);
      if ('approvalId' in outcome) return;
      if (outcome.ok) {
        const decided = outcome.value.docEditProposalDispositionV1;
        setAcknowledged(decided);
        // On a phone the receipt scrolls away with the thread; the app's one notice confirms the new
        // version and keeps Undo in reach (lab K1-Rp). Wider layouts show the receipt in place.
        if (decided.state === 'accepted' && readViewportClass() === 'compact')
          announceAccepted(client, artifactId, base.bodyVersion, decided.acceptedRevision);
        return;
      }
      const code = outcome.failure.code;
      if (code === VERSION_MISMATCH) {
        setCurrency('movedOn');
        setRefusal('movedOn');
        return;
      }
      setRefusal(
        code === 'doc_edit_proposal_edit_access_required'
          ? 'cantEdit'
          : 'failed',
      );
    },
    [base, busy, client, proposalRef],
  );

  const undoAccepted = React.useCallback(async () => {
    if (disposition.state !== 'accepted' || busy) return;
    setBusy('undo');
    const outcome = await client.restoreRevision({
      artifactId,
      bodyVersion: base.bodyVersion,
      expectedRevision: disposition.acceptedRevision,
    });
    setBusy(null);
    if ('approvalId' in outcome) return;
    setUndo(
      outcome.ok
        ? { state: 'done', revision: outcome.value.revision }
        : outcome.failure.code === VERSION_MISMATCH
          ? { state: 'conflict' }
          : { state: 'failed' },
    );
  }, [artifactId, base.bodyVersion, busy, client, disposition]);

  const docTitle = getStorage()((state) => state.artifacts[artifactId]?.title ?? null);
  const readOnly = refusal === 'cantEdit' || admitted?.access === 'view';
  // Compare: the version the suggestion was reviewed against beside the current text, in History.
  const compare = React.useCallback(() => showArtifactHistorySheet({
    artifactId, name: docTitle || t('artifacts.untitled'), canRestore: !readOnly, compareFromBodyVersion: base.bodyVersion,
  }), [artifactId, base.bodyVersion, docTitle, readOnly]);
  const proposer = props.proposer ?? null;
  const askable = proposalRef !== null && proposer !== null
    && !('accountId' in proposer.mention && proposer.mention.accountId === props.viewerAccountId);
  // Ask to redo prepares an addressed reply in this thread; the person still reads and sends it.
  const askToRedo = React.useCallback(() => {
    if (!proposalRef || !proposer) return;
    const mention = `@${proposer.label}`;
    router.push(client.beginProposalReply({
      proposalRef,
      text: `${mention} ${t('artifacts.browser.proposal.redoRequest')}`,
      mentions: [{ start: 0, end: mention.length, ...proposer.mention }],
    }) as never);
  }, [client, proposalRef, proposer, router]);

  const openDocument = React.useCallback(
    () => router.push(artifactViewRoute(artifactId) as never),
    [artifactId, router],
  );
  const decider = (accountId: string) =>
    accountId === props.viewerAccountId
      ? null
      : (props.resolveAccountLabel(accountId) ??
        t('artifacts.browser.proposal.someone'));

  if (disposition.state === 'accepted') {
    const who = decider(disposition.decidedBy.accountId);
    return (
      <View testID={testID} style={styles.card}>
        <Settled
          testID={`${testID}.accepted`}
          icon="check"
          text={
            who
              ? t('artifacts.browser.proposal.acceptedBy', {
                  who,
                  n: disposition.acceptedRevision.bodyVersion,
                })
              : t('artifacts.browser.proposal.acceptedByYou', {
                  n: disposition.acceptedRevision.bodyVersion,
                })
          }
          action={
            undo?.state === 'done'
              ? null
              : {
                  label: t('artifacts.browser.proposal.undo'),
                  busy: busy === 'undo',
                  onPress: () => void undoAccepted(),
                  testID: `${testID}.undo`,
                }
          }
        />
        {undo?.state === 'done' ? (
          <Line
            testID={`${testID}.undone`}
            icon="clock-counter-clockwise"
            text={t('artifacts.browser.proposal.undone', {
              n: undo.revision.bodyVersion,
            })}
          />
        ) : null}
        {undo?.state === 'conflict' ? (
          <Line
            testID={`${testID}.undoConflict`}
            tone="warning"
            icon="warning"
            text={t('artifacts.browser.proposal.undoConflict')}
            action={{
              label: t('artifacts.browser.proposal.openDocument'),
              onPress: openDocument,
            }}
          />
        ) : null}
        {undo?.state === 'failed' ? (
          <Line
            testID={`${testID}.undoFailed`}
            tone="danger"
            icon="warning-circle"
            text={t('artifacts.browser.proposal.failed')}
          />
        ) : null}
      </View>
    );
  }
  if (disposition.state === 'declined') {
    const who = decider(disposition.decidedBy.accountId);
    return (
      <View testID={testID} style={styles.card}>
        <Settled
          testID={`${testID}.declined`}
          icon="x"
          action={null}
          text={
            who
              ? t('artifacts.browser.proposal.declinedBy', { who })
              : t('artifacts.browser.proposal.declinedByYou')
          }
        />
      </View>
    );
  }

  const movedOn = currency === 'movedOn' || refusal === 'movedOn';
  return (
    <View testID={testID} style={styles.card}>
      <View style={styles.head}>
        <Icon
          name="pencil-simple"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text variant="label" emphasis="semiBold" style={styles.title}>
          {t('artifacts.browser.proposal.title')}
        </Text>
        <Text variant="meta" style={styles.meta}>
          {t('artifacts.browser.proposal.basedOn', { n: base.bodyVersion })}
        </Text>
      </View>
      <ProseDiffViewer
        mode="text"
        testID={`${testID}.diff`}
        oldText={proposal.before}
        newText={proposal.after}
        contextLines={0}
        prose={{
          oldLabel: t('artifacts.browser.proposal.before'),
          newLabel: t('artifacts.browser.proposal.after'),
        }}
      />
      {proposal.reason.trim() ? (
        <View style={styles.reason}>
          <Icon
            name="arrow-elbow-down-right"
            size={ICON_SIZE.sm}
            color={theme.colors.text.tertiary}
          />
          <Text variant="body" style={styles.reasonText}>
            {proposal.reason}
          </Text>
        </View>
      ) : null}
      {movedOn ? (
        <>
          <Line
            testID={`${testID}.movedOn`}
            tone="warning"
            icon="warning"
            text={
              refusal === 'failed'
                ? t('artifacts.browser.proposal.failed')
                : t('artifacts.browser.proposal.movedOn')
            }
          />
          {/* Two ways forward (lab K1-ST): see what changed, or ask for a fresh suggestion. A suggestion
              that can no longer apply can still be declined; that needs no Doc rewrite. */}
          <View style={styles.foot}>
            <RoundButton
              testID={`${testID}.compare`}
              size="small"
              display="inverted"
              title={t('artifacts.browser.proposal.compare')}
              textStyle={{ color: theme.colors.text.secondary }}
              onPress={compare}
            />
            <View style={styles.grow} />
            <View style={styles.buttons}>
              {proposalRef && !readOnly ? (
                <RoundButton
                  testID={`${testID}.decline`}
                  size="small"
                  display="inverted"
                  title={t('artifacts.browser.proposal.decline')}
                  textStyle={{ color: theme.colors.text.secondary }}
                  loading={busy === 'decline'}
                  disabled={busy !== null}
                  onPress={() => void decide('decline')}
                />
              ) : null}
              {askable ? (
                <RoundButton
                  testID={`${testID}.askRedo`}
                  size="small"
                  title={t('artifacts.browser.proposal.askRedo')}
                  disabled={busy !== null}
                  onPress={askToRedo}
                />
              ) : null}
            </View>
          </View>
        </>
      ) : refusal === 'cantEdit' || admitted?.access === 'view' ? (
        <Line
          testID={`${testID}.cantEdit`}
          icon="lock"
          text={t('artifacts.browser.proposal.cantEdit')}
        />
      ) : (
        <View style={styles.foot}>
          <View style={styles.status} accessibilityLiveRegion="polite">
            {busy === 'accept' || busy === 'decline' ? (
              <ActivitySpinner size="small" />
            ) : currency === 'current' ? (
              <Icon
                name="check"
                size={ICON_SIZE.sm}
                color={theme.colors.text.tertiary}
              />
            ) : null}
            <Text
              testID={currency === 'current' ? `${testID}.current` : undefined}
              variant="meta"
              style={styles.meta}
              numberOfLines={2}
            >
              {busy === 'accept'
                ? t('artifacts.browser.proposal.accepting')
                : busy === 'decline'
                  ? t('artifacts.browser.proposal.declining')
                  : refusal === 'failed'
                    ? t('artifacts.browser.proposal.failed')
                    : currency === 'current'
                      ? t('artifacts.browser.proposal.current', {
                          n: base.bodyVersion,
                        })
                      : ''}
            </Text>
          </View>
          {proposalRef ? (
            <View style={styles.buttons}>
              <RoundButton
                testID={`${testID}.decline`}
                size="small"
                display="inverted"
                title={t('artifacts.browser.proposal.decline')}
                textStyle={{ color: theme.colors.text.secondary }}
                disabled={busy !== null}
                onPress={() => void decide('decline')}
              />
              <RoundButton
                testID={`${testID}.accept`}
                size="small"
                title={t('artifacts.browser.proposal.accept')}
                disabled={busy !== null}
                loading={busy === 'accept'}
                onPress={() => void decide('accept')}
              />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

export type ProposalAuthor = Readonly<{
  label: string;
  mention: Readonly<{ accountId: string }> | Readonly<{ sessionId: string }>;
}>;

type LineAction = Readonly<{
  label: string;
  onPress: () => void;
  busy?: boolean;
  testID?: string;
}>;

/** The one-line receipt a settled suggestion folds into (lab K1r). */
function Settled(
  props: Readonly<{
    testID: string;
    icon: IconName;
    text: string;
    action: LineAction | null;
  }>,
) {
  return (
    <Line
      testID={props.testID}
      icon={props.icon}
      text={props.text}
      action={props.action ?? undefined}
      strong
    />
  );
}

function Line(
  props: Readonly<{
    testID: string;
    icon: IconName;
    text: string;
    tone?: 'warning' | 'danger';
    strong?: boolean;
    action?: LineAction;
  }>,
) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const color =
    props.tone === 'warning'
      ? theme.colors.state.warning.foreground
      : props.tone === 'danger'
        ? theme.colors.text.destructive
        : theme.colors.text.secondary;
  return (
    <View
      testID={props.testID}
      style={styles.line}
      accessibilityLiveRegion="polite"
    >
      <Icon name={props.icon} size={ICON_SIZE.sm} color={color} />
      <Text
        variant="meta"
        emphasis={props.strong ? 'medium' : undefined}
        style={[
          styles.lineText,
          { color: props.strong ? theme.colors.text.primary : color },
        ]}
      >
        {props.text}
      </Text>
      {props.action ? (
        <RoundButton
          testID={props.action.testID}
          size="small"
          display="inverted"
          title={props.action.label}
          loading={props.action.busy}
          onPress={props.action.onPress}
        />
      ) : null}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.space.s8,
    padding: theme.space.s12,
    gap: theme.space.s10,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
    ...resolveThemeHairlineBorderStyle(theme.colors.border.subtle),
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  title: { flex: 1, color: theme.colors.text.primary },
  meta: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
  reason: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s6,
  },
  reasonText: { flex: 1, color: theme.colors.text.secondary },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
  },
  status: {
    flex: 1,
    minWidth: 160,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  grow: { flex: 1 },
  // One line: the receipt text takes what is left and wraps inside itself, so its action stays at
  // the end of the line even in a narrow Doc margin (lab K1-R).
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  lineText: { flex: 1, minWidth: 0 },
}));

const ACCEPTED_NOTICE_KEY = 'artifacts.proposal.accepted';

/** The accepted-edit notice; its Undo restores the base version unless the Doc moved on since. */
function announceAccepted(client: ArtifactActionsClient, artifactId: string, baseBodyVersion: number, accepted: Revision): void {
  publishPresentationNotice({
    key: ACCEPTED_NOTICE_KEY,
    severity: 'info',
    message: t('artifacts.browser.passage.acceptedToast', { n: accepted.bodyVersion }),
    undo: {
      label: t('artifacts.browser.proposal.undo'),
      run: () => {
        void client.restoreRevision({ artifactId, bodyVersion: baseBodyVersion, expectedRevision: accepted }).then((outcome) => {
          if ('approvalId' in outcome) return;
          publishPresentationNotice(outcome.ok
            ? { key: ACCEPTED_NOTICE_KEY, severity: 'info', message: t('artifacts.browser.proposal.undone', { n: outcome.value.revision.bodyVersion }) }
            : { key: ACCEPTED_NOTICE_KEY, severity: 'warning', message: outcome.failure.code === VERSION_MISMATCH
              ? t('artifacts.browser.proposal.undoConflict') : t('artifacts.browser.proposal.failed') });
        });
      },
    },
  });
}
