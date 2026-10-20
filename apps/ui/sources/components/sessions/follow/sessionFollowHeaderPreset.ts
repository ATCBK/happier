import { resolveEffectiveAccountFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { isSessionPersonallyTrackedForViewerV1 } from '@happier-dev/protocol/sessions/personal/tracking';

import { normalizeSessionViewerCompatibility } from '@/sync/domains/session/readState/sessionViewer';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

/** What the header chip says: the effective delivery preset, or `none` when delivery is off. */
export type SessionFollowHeaderPreset = FollowPolicyV1['preset'] | 'none';

/**
 * The personal Follow level the header chip shows, from the synced viewer facts through the Home's own
 * owners: owner-or-active-Follow tracking, then the effective policy (an owner without a stored
 * choice is Important). A malformed current projection is unknown (null), never a claimed level.
 */
export function readSessionFollowHeaderPreset(
  session: Parameters<typeof normalizeSessionViewerCompatibility>[0],
): SessionFollowHeaderPreset | null {
  const normalized = normalizeSessionViewerCompatibility(session);
  if (normalized.kind === 'legacy_owner') return 'important';
  if (normalized.kind !== 'current')
    return session.viewer === undefined ? 'none' : null;
  const isSessionOwner = isSessionAccessOwner(
    session.access,
    session.accessLevel,
  );
  const facts = normalized.viewer.follow;
  if (
    !isSessionPersonallyTrackedForViewerV1({
      isSessionOwner,
      followFacts: facts,
    })
  )
    return 'none';
  return resolveEffectiveAccountFollowPolicyV1({ facts, isSessionOwner })?.preset ?? 'none';
}
