import * as React from 'react';

import {
  BrandMark,
  Button,
  Dropdown,
  EmptyState,
  Row,
  SessionChat,
  Stack,
  Status,
  Tabs,
  Text,
  usePluginTheme,
  usePluginTranslation,
  useSessionStates,
} from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1, TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';
import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';
import { readTriageSessionTitle } from './sessionTitle.js';
import type { TriageDetailTabSelectionV1 } from './body.js';
import { useTriageUnlinkLinkedEntry } from '../../sessions/cockpit/useUnlinkLinkedEntry.js';

const FILL_STYLE = Object.freeze({ flex: 1, minWidth: 0, minHeight: 0 });
/** The Session name's readable measure before the actions leave its line, in characters (as `shell/layout.ts`). */
const SESSION_TITLE_MEASURE_CHARACTERS = 24;
const AVERAGE_CHARACTER_ADVANCE_PER_FONT_SIZE = 0.5;

function TriageSessionUnlinkControl(props: Readonly<{
  sessionId: string;
  entryRef: TriageEntryRefV1;
  onUnlinked: () => void | Promise<void>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { spacing } = usePluginTheme();
  const { phase, unlink } = useTriageUnlinkLinkedEntry(props.onUnlinked);
  return (
    // Beside Open session the removing control keeps a wider berth than the row's gap, so a thumb aiming at Open
    // at 390 cannot land on it.
    <Stack gap="xsmall" style={{ marginLeft: spacing.small }}>
      <Button
        titleKey="plugins.triage.sessionLinks.unlink"
        title="Unlink"
        variant="plain"
        busy={phase === 'removing'}
        disabled={phase === 'removing'}
        onPress={() => { void unlink({ sessionId: props.sessionId, entryRef: props.entryRef }); }}
      />
      {phase === 'failed' ? <Status tone="warning" label={text('plugins.triage.sessionLinks.unlinkFailed', 'This link could not be removed.')} /> : null}
    </Stack>
  );
}

/**
 * The entry's linked investigation, live (plan 05 §4.6): the real Session — transcript, prompts
 * and composer — rendered by Happier through `SessionChat`, with one explicit way to open it in
 * full. Mounted details use the shell's surface-local selection and Action callback. The local
 * fallback serves standalone presentation only; no mounted detail uses it.
 */
export function TriageSessionPanel(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  entryRef: TriageEntryRefV1;
  onUnlinked: () => void | Promise<void>;
  selectedSessionId?: TriageLinkedSessionProjectionV1['sessionId'] | null;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { spacing, typography } = usePluginTheme();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const opener = useLinkedSessionOpen();
  // The first linked Session (projection order) until the person picks another; a pick that
  // leaves the projection falls back to the first rather than to nothing.
  const selected = props.sessions.find((session) => session.sessionId === (props.selectedSessionId ?? selectedId)) ?? props.sessions[0];
  // The Agent mark comes only from the host's canonical Session projection: its admitted
  // `agent.brand` is the exact BrandMark target. Without it the title stays unmarked; the
  // Session title or any default never stands in for an Agent.
  const sessionStates = useSessionStates(props.sessions.map((session) => session.sessionId)).sessions;
  const agentBrandPluginId = sessionStates.get(selected?.sessionId ?? '')?.state?.agent?.brand?.pluginId;
  if (selected === undefined) return null;
  const titleOf = (session: TriageLinkedSessionProjectionV1) => (
    readTriageSessionTitle(sessionStates.get(session.sessionId)?.state, text)
  );
  const pickerLabel = text('plugins.triage.surface.detail.session.picker', 'Linked session');
  // The Session's name keeps a readable measure; where it and the two actions do not fit on one line (a
  // phone), the actions move beneath it together instead of squeezing the name down to a word.
  const titleMeasure = typography.label.fontSize * SESSION_TITLE_MEASURE_CHARACTERS * AVERAGE_CHARACTER_ADVANCE_PER_FONT_SIZE;
  return (
    <Stack style={FILL_STYLE}>
      <Row gap="small" align="center" wrap style={{ paddingVertical: spacing.small, minHeight: HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE }}>
        <Row gap="small" align="center" style={{ flexGrow: 1, flexShrink: 1, flexBasis: titleMeasure, minWidth: 0 }}>
          {agentBrandPluginId === undefined ? null : <BrandMark pluginId={agentBrandPluginId} size="small" />}
          <Stack style={FILL_STYLE}>
            {props.sessions.length > 1 ? (
              <Dropdown
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                trigger={titleOf(selected)}
                triggerAppearance="control"
                triggerAccessibilityLabel={`${pickerLabel}: ${titleOf(selected)}`}
                items={props.sessions.map((session) => ({
                  id: session.sessionId,
                  label: titleOf(session),
                  kind: 'radio' as const,
                  radioGroupId: 'linked-session',
                }))}
                radioGroups={[{ id: 'linked-session', accessibilityLabel: pickerLabel, selectedId: selected.sessionId }]}
                onSelect={(sessionId) => {
                  if (props.onSelectSession === undefined) setSelectedId(sessionId);
                  else props.onSelectSession(sessionId);
                  setPickerOpen(false);
                }}
              />
            ) : (
              <Text variant="label" value={titleOf(selected)} numberOfLines={1} />
            )}
          </Stack>
        </Row>
        <Row gap="small" align="center">
          <Button
            titleKey="plugins.triage.surface.detail.session.open"
            title="Open session"
            variant="secondary"
            busy={opener.busySessionId !== null}
            onPress={() => { void opener.open(selected.sessionId); }}
          />
          <TriageSessionUnlinkControl key={selected.sessionId} sessionId={selected.sessionId}
            entryRef={props.entryRef} onUnlinked={props.onUnlinked} />
        </Row>
      </Row>
      {opener.failedSessionId !== selected.sessionId ? null : (
        <Status tone="danger" labelKey="plugins.triage.surface.detail.sessionOpenFailed"
          label="This Session could not be opened." />
      )}
      <Stack style={FILL_STYLE}>
        <SessionChat
          // One provider per Session: switching the selection replaces the controller.
          key={selected.sessionId}
          sessionId={selected.sessionId}
          testID="triage-detail-session"
          fallback={(
            <EmptyState
              titleKey="plugins.triage.surface.detail.session.unavailableHere"
              title="Open this session in Happier to follow it live."
            />
          )}
        />
      </Stack>
    </Stack>
  );
}

/**
 * A source that declares no tabs keeps its whole detail; with a linked Session the body gains
 * Details | Session above it (plan 05 §4.6), and without one it is exactly the source's detail.
 */
export function TriageDetailWholeBody(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  entryRef: TriageEntryRefV1;
  onUnlinked: () => void | Promise<void>;
  tabSelection?: TriageDetailTabSelectionV1;
  selectedSessionId?: TriageLinkedSessionProjectionV1['sessionId'] | null;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  children: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<'details' | 'session'>('details');
  const value = props.tabSelection === undefined ? selected : props.tabSelection.value === 'session' ? 'session' : 'details';
  const reportAvailableTabs = props.tabSelection?.onAvailableTabsChange;
  React.useLayoutEffect(() => {
    reportAvailableTabs?.(props.sessions.length === 0 ? [] : [{ id: 'details' }, { id: 'session' }]);
  }, [props.sessions.length, reportAvailableTabs]);
  if (props.sessions.length === 0) return <>{props.children}</>;
  return (
    <Tabs
      value={value}
      onValueChange={(value) => {
        setSelected(value === 'session' ? 'session' : 'details');
        props.tabSelection?.onChange(value);
      }}
      ariaLabel={text('plugins.triage.surface.detail.tabs', 'Entry detail')}
      // The Session tab hosts the live chat, which needs the detail's remaining height.
      layout="fill"
    >
      <Tabs.Item value="details" title={text('plugins.triage.surface.detail.tab.details', 'Details')} retention="retain">
        {props.children}
      </Tabs.Item>
      <Tabs.Item value="session" title={text('plugins.triage.surface.detail.tab.session', 'Session')} retention="retain">
        <TriageSessionPanel sessions={props.sessions} entryRef={props.entryRef} onUnlinked={props.onUnlinked}
          selectedSessionId={props.selectedSessionId} onSelectSession={props.onSelectSession} />
      </Tabs.Item>
    </Tabs>
  );
}
