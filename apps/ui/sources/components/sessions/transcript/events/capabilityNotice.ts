import { readSessionCapabilityNoticeV1, type SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

import { mcpServerRoute, MCP_COLLECTION_ROUTE } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { SKILLS_COLLECTION_ROUTE, skillDisplayName, skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { describeCapabilityNoticeReason, readCapabilityNoticeReason } from '@/components/capabilities/status/capabilityNoticeReason';
import { t } from '@/text';

type NoticeItem = SessionCapabilityNoticeV1['items'][number];

export type CapabilityNoticePresentation = Readonly<{ lines: readonly string[]; href: string; linkLabel: string }>;

function describeReason(item: NoticeItem): string | null {
  const reason = readCapabilityNoticeReason(item);
  return reason ? describeCapabilityNoticeReason(reason) : null;
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
      : t('capabilities.notice.couldntLoad', { name: item.kind === 'skill' && item.itemId ? skillDisplayName(item.name, item.itemId) : item.name });
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
