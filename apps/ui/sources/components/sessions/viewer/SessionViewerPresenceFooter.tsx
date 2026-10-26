import * as React from 'react';

import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { t } from '@/text';
import { CompanionNoDragRegion } from '@/components/companion/interaction/CompanionNoDragRegion';

import { useSessionViewerPresence } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';
import { useSessionViewerMachine } from './useSessionViewerMachine';

/**
 * Who acts on the presented source, below the picture (lab `b-watch` `.fa-vbot`): the one presence
 * capsule the source's owner states, in flow under the frame. The takeover stays with that owner.
 * While the Agent acts, its line under the viewer is the same for both sources, "{agent} is working on
 * {machine}" (plan 63 `sessionViewer.agentControl`): the picture already shows which window or page.
 */
export function SessionViewerPresenceFooter(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    compact?: boolean;
    /** The frame's width: a frame shrunk to a small window recomposes the capsule instead of clipping it. */
    frameWidth?: number;
  }>,
): React.ReactElement | null {
  const presence = useSessionViewerPresence(props.source);
  const machine = useSessionViewerMachine(props.sessionId, props.serverId, props.source);
  if (!presence) return null;
  // "Working on" claims an action in flight. While the agent only holds the source (shared, allowed,
  // no turn acting) the source's own line stands ("Codex can see Safari").
  const agentActing = presence.presence.kind === 'agent' && presence.presence.activity !== null;
  return (
    <CompanionNoDragRegion>
    <BrowserPresenceCapsule
      {...presence}
      agentTitle={machine.name && agentActing
        ? t('computerUse.presentation.agentWorkingOn', { agent: presence.agent.name, machine: machine.name })
        : presence.agentTitle}
      placement="inline"
      compact={props.compact}
      availableWidth={props.frameWidth}
      testID="session-viewer-presence"
    />
    </CompanionNoDragRegion>
  );
}
