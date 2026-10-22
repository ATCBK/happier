import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

type ConversationHitLinkFacts = Readonly<{
  linkedSessionId?: string;
  imported?: boolean;
  searchMode?: 'indexed' | 'standard';
}>;

/**
 * Whether a hit is already a Happier session (lab H1r/H2). Linked and imported both read "In Happier";
 * The link/import lookup does not prove absence of an ordinary hosted native Session.
 * Without positive proof a scanned or indexed hit stays neutral.
 */
export function resolveConversationHitStatusLabel(
  candidate: ConversationHitLinkFacts,
): string | null {
  const inHappier =
    Boolean(candidate.linkedSessionId) || candidate.imported === true;
  return inHappier ? t('externalSessions.browseContentInHappier') : null;
}

/**
 * Below this measured list width the status leaves the title's line and ends the meta line instead, so
 * a phone keeps the title whole (only a short value or a chevron sits beside a label).
 */
export function isConversationHitStatusInMeta(
  listWidthPx: number | null | undefined,
): boolean {
  return (
    typeof listWidthPx === 'number' &&
    listWidthPx > 0 &&
    listWidthPx < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx
  );
}

/**
 * How much of what precedes the first match a hit keeps. A hit's text is clamped to two lines, so the
 * match must sit on the first one: about this many characters leave it there on a phone row, and a wide
 * row reads the same as the lab's short lead.
 */
const SNIPPET_LEAD_CHARS = 24;

/** The snippet starting a few words before its first match, so the clamp never hides the match. */
export function trimConversationHitLead(snippet: string, query: string | undefined): string {
    const first = queryRanges(snippet, query ?? '')?.[0];
    if (!first || first.start <= SNIPPET_LEAD_CHARS) return snippet;
    const lead = snippet.slice(first.start - SNIPPET_LEAD_CHARS, first.start);
    const wordStart = lead.search(/\s\S/);
    const from = wordStart < 0 ? first.start - SNIPPET_LEAD_CHARS : first.start - SNIPPET_LEAD_CHARS + wordStart + 1;
    return `…${snippet.slice(from)}`;
}

/** The title keeps its match in view only this far in: about its first two lines on a phone. */
const TITLE_MATCH_VISIBLE_CHARS = 56;

function comparableText(text: string): string {
  return text.replace(/…|\.{3}/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** One plain-text projection for visible, searchable and spoken conversation snippets. */
export function formatConversationHitSnippet(text: string): string {
  return stripMarkdown(text, { omitRolePrefixes: true, preserveOrderedListNumbers: true });
}

/**
 * The snippet a hit row shows beneath its title. A conversation is titled by its first message, so the
 * matched text is often the title itself: the title carries the match tint (`Item.titleHighlightQuery`)
 * and the row drops the snippet that would only say the same sentence again. When the title does not
 * show the match (different text, or the match sits past its clamp) the snippet stays.
 */
export function resolveConversationHitSnippet(
  input: Readonly<{ title: string; snippet: string | null | undefined; query: string | undefined }>,
): string | null {
  // Match the native corpus elsewhere; preview and highlight the displayed text here.
  const snippet = input.snippet == null ? null : formatConversationHitSnippet(input.snippet);
  const title = stripMarkdown(input.title);
  const query = input.query?.trim();
  if (!snippet || !query) return snippet;
  const text = comparableText(snippet);
  if (!text || !comparableText(title).includes(text)) return snippet;
  const first = queryRanges(title, query)?.[0];
  return first && first.end <= TITLE_MATCH_VISIBLE_CHARS ? null : snippet;
}

/** One conversation hit everywhere: two lines of matched text, then the quiet where · when · how long. */
export function ConversationHitSummary(
  props: Readonly<{
    /** Null when the row's title already shows the match (see `resolveConversationHitSnippet`). */
    snippet: string | null;
    query?: string;
    where?: string | null;
    atMs?: number;
    /** The whole transcript's length, only when the Agent knows it (never a hit ordinal). */
    messageCount?: number;
    /** The hit's in-Happier status when the row is too narrow to carry it beside the title. */
    status?: string | null;
    testID?: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const density = useResolvedItemDensity(undefined);
  const snippet = React.useMemo(
    () => (props.snippet === null ? null : trimConversationHitLead(props.snippet, props.query)),
    [props.snippet, props.query],
  );
  const meta = [
    props.where,
    props.atMs && props.atMs > 0 ? formatShortRelativeTime(props.atMs) : '',
    props.messageCount !== undefined && props.messageCount > 0
      ? t('externalSessions.browseContentMessageCount', {
          count: props.messageCount,
        })
      : '',
    props.status,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={{ gap: theme.space.s2 }}>
      {snippet !== null ? (
        <Text
          testID={props.testID}
          numberOfLines={2}
          style={[
            Typography.default(),
            ITEM_SUBTITLE_TEXT_METRICS[density],
            { color: theme.colors.text.secondary },
          ]}
        >
          <FindHighlightedText
            text={snippet}
            ranges={queryRanges(snippet, props.query ?? '')}
          />
        </Text>
      ) : null}
      {meta ? (
        <Text
          testID={snippet === null ? props.testID : undefined}
          numberOfLines={1}
          style={[
            Typography.variant('meta'),
            Typography.tabular(),
            { color: theme.colors.text.tertiary },
          ]}
        >
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

/** The status beside a hit's title, on rows wide enough to carry it there. */
export function ConversationHitStatus(
  props: Readonly<{ candidate: ConversationHitLinkFacts; testID?: string }>,
): React.ReactElement | null {
  const label = resolveConversationHitStatusLabel(props.candidate);
  return label ? (
    <StatusPill
      variant="neutral"
      hideDot
      labelVariant="phrase"
      testID={props.testID}
      label={label}
    />
  ) : null;
}
