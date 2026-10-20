import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceDestinationBody } from '@/components/appShell/workspace/WorkspaceDestinationBody';
import { resolveDestinationRefFromHref, useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import {
  HeaderActionsScope,
  useStackHeaderActionsClaimed,
  useStackHeaderActionsPublisher,
} from '@/components/navigation/stackHeaderActions';
import { SessionPeekDetailsView } from '@/components/sessions/work/SessionPeekDetailsView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { WorkflowRunPane } from '@/components/workflows/run/WorkflowRunPane';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useOptionalInboxModel } from '@/hooks/inbox/useInboxModel';
import { t } from '@/text';

import { INBOX_ITEM_DETAIL_REGISTRY, resolveInboxItemPageRoute, type InboxItemFocus } from '../inboxItemFocus';

function describeOpenPage(focus: InboxItemFocus): string {
  return t(INBOX_ITEM_DETAIL_REGISTRY[focus.kind].openLabel);
}

/**
 * The detail beside the Inbox list (lab `inbox-I1`): the selected item itself, drawn by the same
 * component its own page uses, so an answer given here is the answer. The pane's two controls —
 * leave for the item's page, close — ride in that component's own header; only content that draws
 * no header (still loading, failed) gets them on a slim bar of their own.
 */
export const InboxItemDetail = React.memo(function InboxItemDetail(
  props: Readonly<{
    focus: InboxItemFocus;
    onClose: () => void;
  }>,
) {
  const router = useRouter();
  const { focus, onClose } = props;
  const model = useOptionalInboxModel();
  const scopeKey = `inbox-detail:${React.useId()}`;
  const notice = focus.kind === 'notice'
    ? model?.accountNotices.find(entry => entry.artifact.id === focus.id)?.header
      ?? model?.openUsageNotices.find(entry => entry.artifact.id === focus.id)?.header : null;
  const pageRoute = resolveInboxItemPageRoute(focus, { notice });
  const openLabel = describeOpenPage(focus);
  const renderControls = React.useCallback(
    () => (
      <>
        <IconButton
          testID="inbox.detail.open"
          variant="plain"
          iconName="arrow-square-out"
          accessibilityLabel={openLabel}
          tooltip={openLabel}
          onPress={() => router.push(pageRoute as never)}
        />
        <IconButton
          testID="inbox.detail.close"
          variant="plain"
          iconName="x"
          accessibilityLabel={t('common.close')}
          tooltip={t('common.close')}
          onPress={onClose}
        />
      </>
    ),
    [onClose, openLabel, pageRoute, router],
  );
  useStackHeaderActionsPublisher(scopeKey, renderControls);
  const controlsInHeader = useStackHeaderActionsClaimed(scopeKey);
  const focusKey = `${focus.kind}:${focus.serverId}:${focus.id}:${focus.kind === 'workflow_run' ? focus.invocationId ?? '' : focus.kind === 'discussion' ? focus.messageId : ''}`;

  return (
    <View testID="inbox.detail" style={styles.root}>
      {controlsInHeader ? null : (
        <View style={styles.bar}>{renderControls()}</View>
      )}
      <HeaderActionsScope scopeKey={scopeKey}>
        <InboxItemDetailBody
          key={focusKey}
          focus={focus}
          pageRoute={pageRoute}
          onClose={onClose}
        />
      </HeaderActionsScope>
    </View>
  );
});

type DetailBodyProps = Readonly<{
    focus: InboxItemFocus;
    pageRoute: string;
    onClose: () => void;
}>;

function ApprovalDetailAdapter(props: DetailBodyProps) {
  return props.focus.kind === 'approval' ? (
        <ApprovalDetailScreen
          artifactId={props.focus.id}
          serverId={props.focus.serverId || undefined}
          onBack={props.onClose}
        />
      ) : null;
}
function SessionDetailAdapter(props: DetailBodyProps) {
  return props.focus.kind === 'session' ? (
        <SessionPeekDetailsView
          sessionId={props.focus.id}
          serverId={props.focus.serverId}
          active
          // The pane's own "open" already leaves for this session's page: one opener, not two.
          openControl={false}
        />
      ) : null;
}
function WorkflowDetailAdapter(props: DetailBodyProps) {
  return props.focus.kind === 'workflow_run' ? (
        <InboxRunDetail
          runId={props.focus.id}
          serverId={props.focus.serverId}
          invocationId={props.focus.invocationId}
          pageRoute={props.pageRoute}
          onClose={props.onClose}
        />
      ) : null;
}

const renderNoSession = () => null;
function PageDetailAdapter(props: DetailBodyProps) {
  const catalog = useCompactAppDestinations();
  const router = useRouter();
  const target = React.useMemo(() => resolveDestinationRefFromHref(catalog, props.pageRoute), [catalog, props.pageRoute]);
  const navigation = React.useMemo<DestinationNavigation>(() => ({ push: router.push, replace: router.replace, back: props.onClose }),
    [router.push, router.replace, props.onClose]);
  if (!target) return <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
  return <DestinationInstanceHost tabId={`inbox-detail:${props.focus.kind}:${props.focus.id}`} ref={target}
    pathname={props.pageRoute} focused visible navigation={navigation}>
    <WorkspaceDestinationBody target={target} pathname={props.pageRoute} renderSession={renderNoSession} renderSessionDetails={renderNoSession} />
  </DestinationInstanceHost>;
}

// Rendering mechanisms only; every source-to-adapter/page decision belongs to the registry above.
const DETAIL_ADAPTERS = { session: SessionDetailAdapter, approval: ApprovalDetailAdapter, workflow_run: WorkflowDetailAdapter, page: PageDetailAdapter };
const InboxItemDetailBody = React.memo(function InboxItemDetailBody(props: DetailBodyProps) {
  const Adapter = DETAIL_ADAPTERS[INBOX_ITEM_DETAIL_REGISTRY[props.focus.kind].detail];
  return <Adapter {...props} />;
});

/**
 * A run is shown by its own page body, hosted here as a destination: the run page reads its run from
 * its destination params, and anything it opens leaves the Inbox for that page, while its Back
 * closes this pane.
 */
const InboxRunDetail = React.memo(function InboxRunDetail(
  props: Readonly<{
    runId: string;
    serverId: string;
    invocationId?: string;
    pageRoute: string;
    onClose: () => void;
  }>,
) {
  const router = useRouter();
  const navigation = React.useMemo<DestinationNavigation>(
    () => ({
      push: router.push,
      replace: router.replace,
      back: props.onClose,
    }),
    [props.onClose, router.push, router.replace],
  );
  return (
    <WorkflowRunPane
      tabId={`inbox-detail:run:${props.runId}`}
      runId={props.runId}
      serverId={props.serverId}
      invocationId={props.invocationId ?? null}
      pathname={props.pageRoute}
      visible
      navigation={navigation}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: theme.colors.surface.base,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s8,
    paddingTop: theme.space.s8,
  },
}));
