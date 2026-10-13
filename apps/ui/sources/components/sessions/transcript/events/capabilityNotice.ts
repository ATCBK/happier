import { readSessionCapabilityNoticeV1, type SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

import { mcpServerRoute, MCP_COLLECTION_ROUTE } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { SKILLS_COLLECTION_ROUTE, skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { t } from '@/text';

type NoticeItem = SessionCapabilityNoticeV1['items'][number];

export type CapabilityNoticePresentation = Readonly<{ lines: readonly string[]; href: string; linkLabel: string }>;

/** The producer stores reasons as `env:KEY`, `header:KEY` or a short code; known ones read as words, others as stored. */
function describeReason(item: NoticeItem): string | null {
  const detail = item.detail ?? item.code;
  const reference = /^(?:env|header):(.+)$/.exec(detail);
  if (reference) return t('capabilities.notice.missing', { key: reference[1] });
  if (detail === 'mcp_sign_in_required') return t('capabilities.notice.signIn');
  if (detail === 'mcp_resource_mismatch') return t('capabilities.notice.signInMismatch');
  if (detail === 'remote bridge unavailable') return t('capabilities.notice.bridge');
  if (detail === 'launch_path_unsupported') return t('capabilities.notice.skillLaunch');
  return item.detail ?? null;
}

/**
 * One quiet line per skipped item, and one link to where it is fixed: the item's own page when a single
 * item was skipped, otherwise its collection. Null for a message that carries no readable notice.
 */
export function describeCapabilityNotice(event: unknown): CapabilityNoticePresentation | null {
  const notice = readSessionCapabilityNoticeV1(event);
  if (!notice || notice.items.length === 0) return null;
  const lines = notice.items.map((item) => {
    const title = item.kind === 'mcp_server'
      ? t('capabilities.notice.couldntStart', { name: item.name })
      : t('capabilities.notice.couldntLoad', { name: item.name });
    const reason = describeReason(item);
    return reason ? `${title} · ${reason}` : title;
  });
  const [first] = notice.items;
  const itemId = notice.items.length === 1 ? first.itemId : undefined;
  if (first.kind === 'prompt_library') {
    return { lines, href: '/settings/prompts', linkLabel: t('promptLibrary.library') };
  }
  return first.kind === 'mcp_server'
    ? { lines, href: itemId ? mcpServerRoute(itemId) : MCP_COLLECTION_ROUTE, linkLabel: t('capabilities.notice.openMcp') }
    : { lines, href: itemId ? skillHref(itemId) : SKILLS_COLLECTION_ROUTE, linkLabel: t('capabilities.notice.openSkills') };
}
