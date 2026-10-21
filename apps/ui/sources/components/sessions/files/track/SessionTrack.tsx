import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { unsavedWorkspaceFilePaths } from '@/components/appShell/panes/details/workspace/detailsTabChrome';
import { DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSessionLiveFileWrites } from '@/sync/domains/session/changes/hooks/useSessionLiveFileWrites';
import { projectUiSessionRuntimeAwareness } from '@/sync/domains/session/attention/runtimePresentation';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useActiveServerAccountScope, useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import { HappierStatusCapsule } from '@happier-dev/plugin-ui/presentation';
import { CORE_CAPSULE_HOST, useCoreCapsuleColors } from '@/components/ui/status/capsuleHost';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { useDeviceType } from '@/utils/platform/responsive';

import { TrackPauseSignalProvider, type TrackPresence, type TrackReveal } from './TrackPauseSignal';
import {
  useTrackAgentEdits,
  type TrackAgentEditsModel,
} from './useTrackAgentEdits';
import { selectTrackTarget, type TrackTarget } from './trackAgentEditsController';

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const TRACK_CAPSULE_TEST_ID = 'session-details-track-capsule';

function isInsideTrackCapsule(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === 'function' && element.closest(`[data-testid="${TRACK_CAPSULE_TEST_ID}"]`) != null;
}

export type SessionTrackModel = TrackAgentEditsModel &
  Readonly<{ agentId: string | null; agentTitle: string; reveal: TrackReveal | null }>;

/**
 * The Session pane's one Track composition (P5 U7): P3's Session-current writes, P4's dirty paths and the
 * canonical opener feed the one controller. Mounted once per Session pane; the strip and the phone read it.
 */
export function useSessionTrack(
  params: Readonly<{
    scopeId: string;
    sessionAddress: SessionAddress;
    workspaceRoot: string | null;
    active: boolean;
  }>,
): SessionTrackModel {
  const pane = useAppPaneScope(params.scopeId);
  const session = useSession(
    params.sessionAddress.sessionId,
    params.sessionAddress.serverId,
  );
  const writes = useSessionLiveFileWrites(
    params.sessionAddress,
    params.workspaceRoot,
  );
  const awareness = session ? projectUiSessionRuntimeAwareness(session) : null;
  const sessionActive =
    awareness !== null &&
    awareness.live &&
    (awareness.working || awareness.backgroundActive);
  const accountScope = useActiveServerAccountScope(params.sessionAddress.serverId);
  const details = pane.scopeState?.details;
  const dirtyList = unsavedWorkspaceFilePaths({
    accountId: accountScope?.accountId ?? null,
    details,
  });
  const dirtyKey = dirtyList.join('\n');
  const dirtyPaths = React.useMemo(
    () => (dirtyList.length ? new Set(dirtyList) : EMPTY_PATHS),
    [dirtyKey],
  );
  const reducedMotion = useReducedMotionPreference();
  const opener = useWorkspaceFileOpener();
  const openFile = React.useCallback<
    Parameters<typeof useTrackAgentEdits>[0]['openFile']
  >(
    (target, options) => {
      void opener.open(target, {
        intent: 'preview',
        present: options.present,
        anchorSource: options.anchorSource,
      });
    },
    [opener],
  );
  // Track decides when to scroll (path change, new region, Resume); the File page showing the path resolves
  // where (the call's lines, or the text it replaces) and scrolls there: one region owner for caret and scroll.
  const [reveal, setReveal] = React.useState<TrackReveal | null>(null);
  const revealRegion = React.useCallback(
    (target: TrackTarget, behavior: 'smooth' | 'instant') => {
      setReveal((previous) => ({ seq: (previous?.seq ?? 0) + 1, path: target.path, behavior }));
    },
    [],
  );
  const track = useTrackAgentEdits({
    scopeId: params.scopeId,
    sessionAddress: params.sessionAddress,
    active: params.active,
    sessionActive,
    writes,
    dirtyPaths,
    reducedMotion,
    revealRegion,
    openFile,
  });
  const agentId = session ? readSessionPresentationAgentId(session) : null;
  const agentTitle = agentId
    ? resolveAgentCatalogTitle(agentId)
    : t('newSession.wizardSection.agent');
  return React.useMemo(
    () => ({ ...track, agentId, agentTitle, reveal }),
    [agentId, agentTitle, reveal, track],
  );
}

/**
 * Where the File pages draw the agent caret and wash: the file this Session's agent writes now, while Track is
 * on (following or paused by your input; the caret reports the agent, pausing only stops the following).
 */
export function readTrackPresence(
  track: Pick<SessionTrackModel, 'enabled' | 'paused' | 'target' | 'agentId' | 'agentTitle' | 'reveal'>,
): TrackPresence | null {
    const target = track.target;
    if (!track.enabled || !target) return null;
    const anchorText = target.region ? undefined : target.write.anchorText;
    if (!target.region && !anchorText) return null;
    return {
        path: target.path,
        ...(target.region ? { region: target.region } : {}),
        ...(anchorText ? { anchorText } : {}),
        agentId: track.agentId,
        agentName: track.agentTitle,
        // Track's scroll request for this path; none while you have taken over (paused).
        ...(track.reveal && track.reveal.path === target.path && !track.paused
            ? { reveal: { seq: track.reveal.seq, behavior: track.reveal.behavior } } : {}),
    };
}

/**
 * Person input inside the Session's details pauses Track at once (P5-I6): wheel, touch, pointer and keys.
 * Track's own moves are programmatic and never reach these handlers.
 */
export function TrackInputBoundary(
  props: Readonly<{ track: SessionTrackModel; children: React.ReactNode }>,
) {
  const { pause } = props.track;
  const following =
    props.track.enabled && !props.track.paused && props.track.target !== null;
  const handlers = React.useMemo(
    () =>
      following
        ? Platform.OS === 'web'
          ? {
              onWheel: () => pause('scroll'),
              onPointerDown: (event: Readonly<{ target?: unknown }>) => {
                // The capsule is the Track control itself; pressing it is not input that should pause.
                if (isInsideTrackCapsule(event.target)) return;
                pause('selection');
              },
              onKeyDown: () => pause('typing'),
            }
          : { onTouchStart: () => pause('touch') }
        : null,
    [following, pause],
  );
  const { enabled, paused, target, agentId, agentTitle, reveal } = props.track;
  const presence = React.useMemo(
    () => readTrackPresence({ enabled, paused, target, agentId, agentTitle, reveal }),
    [enabled, paused, target, agentId, agentTitle, reveal],
  );
  return (
    <TrackPauseSignalProvider signal={pause} presence={presence}>
      <View
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        {...(handlers ?? {})}
      >
        {props.children}
      </View>
    </TrackPauseSignalProvider>
  );
}

/**
 * The strip capsule (lab tr T0–T2): visible only while this Session's agent writes a file. Off it reads
 * "Track" (one tap turns it on), on "Tracking", after your input "Paused · Resume".
 */
export function TrackCapsule(
  props: Readonly<{ track: SessionTrackModel }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const { track } = props;
  if (!track.target) return null;
  const following = track.enabled && !track.paused;
  const label = !track.enabled
    ? t('files.track.track')
    : track.paused
      ? `${t('files.track.paused')} · ${t('files.track.resume')}`
      : t('files.track.tracking');
  const accessibilityLabel = !track.enabled
    ? t('files.track.turnOnA11y', { agent: track.agentTitle })
    : track.paused
      ? t('files.track.resumeA11y', { agent: track.agentTitle })
      : t('files.track.turnOffA11y', { agent: track.agentTitle });
  const glyph = DETAILS_TAB_STRIP_METRICS.actionGlyphPx;
  return (
    <ToolbarButton
      label={label}
      accessibilityLabel={accessibilityLabel}
      active={following}
      icon={
        track.agentId ? (
          <View style={{ opacity: track.enabled ? 1 : 0.55 }}>
            <AgentIcon agentId={track.agentId} size={glyph} />
          </View>
        ) : null
      }
      labelColor={following ? theme.colors.text.primary : undefined}
      onPress={() => {
        if (!track.enabled) track.setEnabled(true);
        else if (track.paused) track.resume();
        else track.setEnabled(false);
      }}
      testID={TRACK_CAPSULE_TEST_ID}
    />
  );
}

/**
 * Phone (lab tr Tp): while this Session's agent writes a file, one capsule above the composer says which
 * file and offers Watch, which turns Track on and opens that file. It leaves when the write ends.
 */
export function PhoneTrackWatchCapsule(props: Readonly<{ sessionAddress: SessionAddress; workspaceRoot: string | null }>): React.ReactElement | null {
  const writes = useSessionLiveFileWrites(props.sessionAddress, props.workspaceRoot);
  const target = selectTrackTarget(writes, props.sessionAddress.sessionId);
  const [, setTrackEnabled] = useLocalSettingMutable('filesTrackAgentEdits');
  const opener = useWorkspaceFileOpener();
  const colors = useCoreCapsuleColors();
  const path = target?.path ?? null;
  const watch = React.useCallback(() => {
    if (!path) return;
    setTrackEnabled(true);
    void opener.open({ kind: 'session', ...props.sessionAddress, path }, {
      intent: 'preview',
      ...(target?.region ? { anchor: { kind: 'fileLine' as const, startLine: target.region.startLine }, anchorSource: 'file' as const } : {}),
    });
  }, [opener, path, props.sessionAddress, setTrackEnabled, target?.region]);
  if (!path) return null;
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return (
    <HappierStatusCapsule
      placement="inline"
      busy
      text={`${t('files.track.writing')} ${fileName}`}
      action={{ label: t('files.track.watch'), onPress: watch }}
      colors={colors}
      host={CORE_CAPSULE_HOST}
      testID="session-phone-track-watch-capsule"
    />
  );
}

/** The transcript's mount: phones only, resolving the Session's workspace once. */
export function SessionPhoneTrackWatchCapsule(props: Readonly<{ sessionId: string; serverId: string | null }>): React.ReactElement | null {
  const phone = useDeviceType() === 'phone';
  const scope = useWorkspaceScopeForSession(phone ? props.sessionId : '', props.serverId);
  const address = React.useMemo(() => props.serverId ? { serverId: props.serverId, sessionId: props.sessionId } : null,
    [props.serverId, props.sessionId]);
  if (!phone || !address) return null;
  return <PhoneTrackWatchCapsule sessionAddress={address} workspaceRoot={scope?.rootPath ?? null} />;
}
