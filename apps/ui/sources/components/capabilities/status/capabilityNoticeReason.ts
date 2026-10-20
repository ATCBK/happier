import type { SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

import { t } from '@/text';

type NoticeItem = Pick<
  SessionCapabilityNoticeV1['items'][number],
  'code' | 'detail'
>;

/** Why a runtime notice says an item didn't start or load, read once for the transcript and the status owners. */
export type CapabilityNoticeReason =
  | Readonly<{ kind: 'sign_in' }>
  | Readonly<{ kind: 'missing_key'; key: string }>
  | Readonly<{ kind: 'words'; text: string }>;

/**
 * The producer stores reasons as `env:KEY`, `header:KEY` or a short code; known ones read as words, other
 * stored detail as stored, and a bare code with no detail as nothing (a code is never shown as words).
 */
export function readCapabilityNoticeReason(
  item: NoticeItem,
): CapabilityNoticeReason | null {
  const detail = item.detail ?? item.code;
  if (detail === 'mcp_sign_in_required' || item.code === 'mcp_sign_in_required')
    return { kind: 'sign_in' };
  const reference = /^(?:env|header):(.+)$/.exec(detail);
  if (reference) return { kind: 'missing_key', key: reference[1]! };
  if (detail === 'mcp_resource_mismatch')
    return { kind: 'words', text: t('capabilities.notice.signInMismatch') };
  if (detail === 'remote bridge unavailable')
    return { kind: 'words', text: t('capabilities.notice.bridge') };
  if (detail === 'launch_path_unsupported')
    return { kind: 'words', text: t('capabilities.notice.skillLaunch') };
  if (detail === 'content_unreadable')
    return { kind: 'words', text: t('capabilities.notice.contentUnreadable') };
  if (detail === 'mcp_request_auth_unavailable' || detail === 'mcp_request_auth_not_active')
    return { kind: 'words', text: t('capabilities.notice.signInUnavailable') };
  // Any other code-shaped detail is a code, not words: the title and its link carry the line.
  if (!item.detail || /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(item.detail)) return null;
  return { kind: 'words', text: item.detail };
}

export function describeCapabilityNoticeReason(
  reason: CapabilityNoticeReason,
): string {
  switch (reason.kind) {
    case 'sign_in':
      return t('capabilities.notice.signIn');
    case 'missing_key':
      return t('capabilities.notice.missing', { key: reason.key });
    case 'words':
      return reason.text;
  }
}
