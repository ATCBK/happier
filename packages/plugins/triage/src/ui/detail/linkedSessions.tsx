import * as React from 'react';

import {
  Item,
  ItemGroup,
  Button,
  Label,
  Stack,
  Status,
  usePluginTranslation,
  useSessionState,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';
import { readTriageSessionTitle } from './sessionTitle.js';

const LinkedSessionRow = React.memo(function LinkedSessionRow(props: Readonly<{
  sessionId: TriageLinkedSessionProjectionV1['sessionId'];
  busy: boolean;
  unavailable: boolean;
  failed: boolean;
  onSelect?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  open: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => Promise<void>;
}>) {
  const text = usePluginTranslation();
  const state = useSessionState(props.sessionId);
  const title = readTriageSessionTitle(state.state, text);
  const description = props.failed
    ? text('plugins.triage.surface.detail.sessionOpenFailed', 'This Session could not be opened.')
    : props.unavailable
      ? text('plugins.triage.surface.detail.sessionUnavailable', 'Another Session is opening.')
      : undefined;
  return (
    <Item
      title={title}
      detail={description}
      accessibilityLabel={title}
      accessibilityHint={description}
      tone={props.failed ? 'danger' : undefined}
      busy={props.busy}
      disabled={props.unavailable}
      onPress={() => {
        if (props.onSelect !== undefined) props.onSelect(props.sessionId);
        else void props.open(props.sessionId);
      }}
      accessoryOutsidePressable
      accessory={<Button
        titleKey="plugins.triage.surface.detail.session.open"
        title="Open session"
        accessibilityLabel={`${text('plugins.triage.surface.detail.session.open', 'Open session')} ${title}`}
        variant="secondary"
        busy={props.busy}
        disabled={props.unavailable}
        onPress={() => { void props.open(props.sessionId); }}
      />}
    />
  );
});

/** Common-header rendering for the bounded read-only linked Session projection. */
export function TriageLinkedSessions(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  hasMore: boolean;
  pageState?: 'idle' | 'loading' | 'failed';
  onLoadMore?: () => void;
  onSelect?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  /** Omit the visible label when an enclosing story step already names the group. */
  labelled?: boolean;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { busySessionId, failedSessionId, open: openSession } = useLinkedSessionOpen();
  if (props.sessions.length === 0) return null;
  return (
    <Stack gap="small">
      {props.labelled === false ? null : (
        <Label value={text('plugins.triage.surface.detail.sessions', 'Sessions')} />
      )}
      <ItemGroup accessibilityLabel={text('plugins.triage.surface.detail.sessions', 'Sessions')}>
        {props.sessions.map((session) => (
          <LinkedSessionRow
            key={session.sessionId}
            sessionId={session.sessionId}
            busy={busySessionId === session.sessionId}
            unavailable={busySessionId !== null && busySessionId !== session.sessionId}
            failed={failedSessionId === session.sessionId}
            onSelect={props.onSelect}
            open={openSession}
          />
        ))}
      </ItemGroup>
      {props.hasMore ? (
        <Button
          titleKey={props.pageState === 'failed'
            ? 'plugins.triage.surface.loadMore.retry'
            : 'plugins.triage.surface.loadMore'}
          title={props.pageState === 'failed' ? 'Retry' : 'Load more'}
          variant="secondary"
          busy={props.pageState === 'loading'}
          disabled={props.onLoadMore === undefined}
          onPress={() => { props.onLoadMore?.(); }}
        />
      ) : null}
      {props.pageState === 'failed' ? (
        <Status
          tone="danger"
          labelKey="plugins.triage.surface.detail.sessionsLoadFailed"
          label="More linked Sessions could not be loaded."
        />
      ) : null}
    </Stack>
  );
}
