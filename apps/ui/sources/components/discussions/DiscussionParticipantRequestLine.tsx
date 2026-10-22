import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { setPendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSessionAwareness } from '@/sync/domains/session/awareness/useSessionAwareness';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { presentSessionAwarenessV1 } from '@/utils/sessions/sessionUtils';

/**
 * C3 §10 step 5 "Open request": one Discussion participant Session that is waiting on its owner (a native
 * permission or question). It reads the Session's own awareness owner, so it appears only for a viewer who
 * can see that Session in this Home and Account; Discussion membership grants nothing. The control opens the
 * request in that Session, where it is answered; nothing here approves it.
 */
export const DiscussionParticipantRequestLine = React.memo(
  function DiscussionParticipantRequestLine(
    props: Readonly<{
      sessionId: string;
      serverId: string;
      accountLifetime: ServerAccountScopeLifetime;
      enabled: boolean;
      /** The participant's name as the roster shows it. */
      label: string;
      /** The host's state-line placement; nothing is laid out while nothing waits. */
      style?: StyleProp<ViewStyle>;
    }>,
  ) {
    const router = useRouter();
    const { awareness, oldestPendingRequest, requestHref } =
      useSessionAwareness(props.sessionId, props.serverId, undefined, {
        accountLifetime: props.accountLifetime,
        enabled: props.enabled,
      });
    const open = React.useCallback(() => {
      if (!requestHref || !oldestPendingRequest) return;
      router.push(requestHref as Href);
      // The Session owns hydration, reveal and the answer; this only says which request to land on.
      setPendingNavigationLanding(
        { serverId: props.serverId, sessionId: props.sessionId },
        oldestPendingRequest.id,
        'pending',
        'prompt',
        oldestPendingRequest.source,
      );
    }, [
      oldestPendingRequest,
      props.serverId,
      props.sessionId,
      requestHref,
      router,
    ]);
    if (!oldestPendingRequest || !requestHref) return null;
    const presented = awareness ? presentSessionAwarenessV1(awareness) : null;
    const status =
      presented &&
      (presented.state === 'permission_required' ||
        presented.state === 'action_required')
        ? presented.statusText
        : oldestPendingRequest.kind === 'permission'
          ? t('status.permissionRequired')
          : t('status.actionRequired');
    return (
      <View style={props.style}>
      <SurfaceStateCard
        testID={`session-discussion-participant-request-${props.sessionId}`}
        size="line"
        kind="warning"
        accessibilitySemantics="status"
        title={`${props.label} · ${status}`}
        action={{
          testID: `session-discussion-participant-request-open-${props.sessionId}`,
          label: t('inbox.work.detail.openApproval'),
          onPress: open,
        }}
      />
      </View>
    );
  },
);
