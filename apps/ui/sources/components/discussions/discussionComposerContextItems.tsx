import * as React from 'react';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import type { AgentInputAttachmentRowBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * What a Discussion draft is about, as the composer's own context badges (the row a Session's
 * source context, review comments and files use): the Doc passage it comments on and the message it
 * replies to. Each opens its source and can be removed; committed messages keep their quotes.
 */
export function createDiscussionPassageBadge(
  params: Readonly<{
    /** Null when the passage can no longer be read here (its source was refused). */
    passage: DocPassageRefV1 | null;
    onOpen?: () => void;
    onRemove: () => void;
  }>,
): AgentInputAttachmentRowBadge {
  const kind = t('session.collaboration.discussion.quote.document');
  const label =
    params.passage?.quote.trim() ||
    t('session.collaboration.discussion.quote.unavailable');
  return {
    kind: 'badge',
    key: 'discussion-passage',
    testID: 'discussion-composer-passage',
    label,
    accessibilityLabel: `${kind}: ${label}`,
    ...(params.passage ? {} : { availability: 'unavailable' as const }),
    icon: (tint: string) => (
      <Icon
        name="quotes"
        size={AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX}
        color={tint}
      />
    ),
    ...(params.passage && params.onOpen ? { onPress: params.onOpen } : {}),
    onRemove: params.onRemove,
    removeAccessibilityLabel: `${t('common.remove')}: ${kind}`,
  };
}

export function createDiscussionReplyBadge(
  params: Readonly<{
    /** The quoted author, or null while the parent is outside the loaded page (it still posts as a reply). */
    authorLabel: string | null;
    text: string | null;
    onOpen?: () => void;
    onRemove: () => void;
  }>,
): AgentInputAttachmentRowBadge {
  const label =
    params.authorLabel !== null
      ? t('session.collaboration.discussion.replyDraft.replyingTo', {
          name: params.authorLabel,
        })
      : t('session.collaboration.discussion.quote.message');
  return {
    kind: 'badge',
    key: 'discussion-reply',
    testID: 'discussion-composer-reply',
    label,
    accessibilityLabel: params.text ? `${label}: ${params.text}` : label,
    icon: (tint: string) => (
      <Icon
        name="arrow-elbow-up-left"
        size={AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX}
        color={tint}
      />
    ),
    ...(params.onOpen ? { onPress: params.onOpen } : {}),
    onRemove: params.onRemove,
    removeAccessibilityLabel: `${t('common.remove')}: ${label}`,
  };
}
