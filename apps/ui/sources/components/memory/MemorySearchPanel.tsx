import { happierPageTextMetrics, HAPPIER_WORK_PANE_METRICS } from '@happier-dev/plugin-ui/presentation';
import {
    isMemoryDocumentSearchHitV1,
    type MemoryDocumentSearchCoverageV1,
    type MemoryDocumentSearchHitV1,
    type MemorySearchCorpusV1,
    type MemorySearchHitV1,
} from '@happier-dev/protocol/memory/memorySearch';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { SessionListIdentity, useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { formatMemoryDate, memoryTopicLabel } from './MemoryDocumentBody';
import { memoryDocumentSearchHitHref } from './memoryDocumentRoutes';

const CORPORA: readonly MemorySearchCorpusV1[] = ['documents', 'sessions'];
/** Typing settles before a machine is asked; a superseded query is cancelled, not raced. */
const SEARCH_SETTLE_MS = 250;
const MIN_QUERY_LENGTH = 2;

type Results = Readonly<{
    query: string;
    status: 'searching' | 'ready' | 'failed';
    documentsCoverage: MemoryDocumentSearchCoverageV1 | null;
    documents: readonly MemoryDocumentSearchHitV1[];
    sessions: readonly MemorySearchHitV1[];
}>;

/**
 * One search over remembered facts (every topic, the archive included) and past sessions (lab
 * `c-mem S`). One engine: the daemon's `memory.search` with the document corpus, through the shared
 * provider decision; it never opens a second index. A remembered hit opens the memory page at its
 * topic (D4-3 `{ type: 'topic', title }`); a session hit opens that session at the match.
 */
export const MemorySearchPanel = React.memo(function MemorySearchPanel(props: Readonly<{
    testID: string;
    serverId: string;
}>) {
    const styles = stylesheet;
    const { serverId, testID } = props;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const accountScope = useActiveServerAccountScope();
    const provider = useMemorySearchProvider({ kind: 'exact', serverId }, { corpora: CORPORA });
    const target = provider.queryAvailable ? provider.daemonTarget : null;
    const [query, setQuery] = React.useState('');
    const [results, setResults] = React.useState<Results | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
    const normalized = query.trim();
    const accountId = accountScope?.accountId ?? null;
    const machineId = target?.machineId ?? null;
    const targetServerId = target?.serverId ?? null;

    React.useEffect(() => {
        if (normalized.length < MIN_QUERY_LENGTH || !machineId || !targetServerId || !accountId) {
            setResults(null);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            // The last results stay on screen while the next query runs.
            setResults((previous) => ({ query: normalized, status: 'searching', documentsCoverage: previous?.documentsCoverage ?? null,
                documents: previous?.documents ?? [], sessions: previous?.sessions ?? [] }));
            void (async () => {
                try {
                    const result = await searchDaemonMemory({
                        serverId: targetServerId, accountId, machineId, query: normalized,
                        scope: { type: 'global' }, mode: 'auto', corpora: CORPORA, signal: controller.signal,
                    });
                    if (controller.signal.aborted) return;
                    if (!result.ok) {
                        setResults({ query: normalized, status: 'failed', documentsCoverage: null, documents: [], sessions: [] });
                        return;
                    }
                    setResults({
                        query: normalized,
                        status: 'ready',
                        documentsCoverage: result.documents ?? { state: 'unavailable' },
                        documents: result.hits.filter(isMemoryDocumentSearchHitV1),
                        sessions: result.hits.filter((hit): hit is MemorySearchHitV1 => !isMemoryDocumentSearchHitV1(hit)),
                    });
                } catch {
                    if (!controller.signal.aborted) setResults({ query: normalized, status: 'failed', documentsCoverage: null, documents: [], sessions: [] });
                }
            })();
        }, SEARCH_SETTLE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [accountId, attempt, machineId, normalized, targetServerId]);

    const openDocument = React.useCallback((hit: MemoryDocumentSearchHitV1) => {
        router.push(memoryDocumentSearchHitHref(hit) as never);
    }, [router]);
    const openSession = React.useCallback((hit: MemorySearchHitV1) => {
        fireAndForget(navigateToSession(hit.sessionId, { serverId, query: { jumpSeq: hit.seqFrom } }), { tag: 'MemorySearchPanel.session' });
    }, [navigateToSession, serverId]);

    const count = (results?.documents.length ?? 0) + (results?.sessions.length ?? 0);
    return (
        <View testID={testID}>
            <View style={styles.field}>
                <CompactSearchField
                    testID={`${testID}.input`}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('memoryContext.memory.searchPlaceholder')}
                    accessibilityLabel={t('memoryContext.memory.search')}
                    editable={target !== null}
                    autoFocus
                    trailing={results && results.status !== 'failed' && normalized.length >= MIN_QUERY_LENGTH ? (
                        <Text style={styles.count}>{t('memoryContext.memory.resultCount', { count })}</Text>
                    ) : undefined}
                />
            </View>
            {target === null ? (
                <SearchNotice testID={`${testID}.unavailable`} kind="warning" title={t('memoryContext.memory.searchUnavailable')} />
            ) : results?.status === 'failed' ? (
                <SearchNotice testID={`${testID}.failed`} kind="error" title={t('memoryContext.memory.offline')} onRetry={retry} />
            ) : null}
            {results?.documentsCoverage && results.documentsCoverage.state !== 'ready' ? (
                <SearchNotice testID={`${testID}.documentsCoverage`}
                    kind={results.documentsCoverage.state === 'pending' ? 'loading' : 'warning'}
                    title={results.documentsCoverage.state === 'pending'
                        ? `${t('memoryContext.memory.remembered')} · ${t('common.loading')}`
                        : t('memoryContext.memory.documentSearchUnavailable')} />
            ) : null}
            {results && results.documents.length > 0 ? (
                <>
                    <CollectionListGroupLabel title={t('memoryContext.memory.remembered')} count={results.documents.length} first />
                    {results.documents.map((hit, index) => {
                        const where = typeof hit.location === 'object' ? memoryTopicLabel(hit.location.title)
                            : hit.location === 'archive' ? t('memoryContext.memory.archive') : null;
                        return (
                            <Item
                                key={`${hit.ref.artifactId}:${hit.factId ?? index}`}
                                testID={`${testID}.remembered.${index}`}
                                // The words that matched are marked in the fact (the Find surfaces' own marks).
                                title={(
                                    <Text numberOfLines={2} style={[styles.hitTitle, hit.location === 'archive' ? styles.retired : null]}>
                                        <FindHighlightedText text={hit.summary} ranges={queryRanges(hit.summary, results.query)} />
                                    </Text>
                                )}
                                accessibilityLabel={hit.summary}
                                subtitle={where ?? undefined}
                                showChevron={false}
                                onPress={() => openDocument(hit)}
                            />
                        );
                    })}
                </>
            ) : null}
            {results && results.sessions.length > 0 ? (
                <>
                    <CollectionListGroupLabel title={t('memoryContext.memory.pastSessions')} count={results.sessions.length} first={results.documents.length === 0} />
                    {results.sessions.map((hit, index) => (
                        <SessionHitRow
                            key={`${hit.sessionId}:${hit.seqFrom}`}
                            testID={`${testID}.session.${index}`}
                            hit={hit}
                            query={results.query}
                            serverId={serverId}
                            onOpen={openSession}
                        />
                    ))}
                </>
            ) : null}
            {results?.status === 'ready' && results.documentsCoverage?.state === 'ready' && count === 0 ? (
                <Text testID={`${testID}.empty`} style={styles.hint}>{t('memoryContext.memory.noResults', { query: results.query })}</Text>
            ) : null}
        </View>
    );
});

/** One quiet state line inside the section's gutters: what is wrong, and Retry when asking again can help. */
function SearchNotice(props: Readonly<{ testID: string; kind: 'loading' | 'warning' | 'error'; title: string; onRetry?: () => void }>) {
    const styles = stylesheet;
    return (
        <View style={styles.notice}>
            <SurfaceStateCard
                testID={props.testID}
                size="line"
                kind={props.kind}
                title={props.title}
                action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
            />
        </View>
    );
}

/**
 * A past-session hit (lab `c-mem S`): the Session's own mark, its title and the date, then one line of
 * its text with the match marked. The excerpt is plain text; indexed transcript chunks carry markdown.
 */
const SessionHitRow = React.memo(function SessionHitRow(props: Readonly<{
    testID: string;
    hit: MemorySearchHitV1;
    query: string;
    serverId: string;
    onOpen: (hit: MemorySearchHitV1) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { hit, onOpen } = props;
    const session = useSession(hit.sessionId, props.serverId);
    const identityDisplay = useSessionListIdentityDisplay();
    const name = session ? getSessionName(session, props.serverId) : null;
    const excerpt = React.useMemo(() => stripMarkdown(hit.summary), [hit.summary]);
    const excerptText = (
        <Text numberOfLines={1} style={name ? styles.hitExcerpt : styles.hitTitle}>
            <FindHighlightedText text={excerpt} ranges={queryRanges(excerpt, props.query)} />
        </Text>
    );
    return (
        <Item
            testID={props.testID}
            leftElement={session && identityDisplay !== 'none' ? (
                <SessionListIdentity
                    session={session}
                    display={identityDisplay}
                    serverId={props.serverId}
                    color={theme.colors.text.secondary}
                    avatarSize={16}
                    agentLogoSize={14}
                    connected
                />
            ) : undefined}
            icon={session && identityDisplay !== 'none' ? undefined : <Icon name="chat-circle" />}
            // A Session this client has not loaded has no name to show: its excerpt is the title.
            title={name ?? excerptText}
            accessibilityLabel={name ?? excerpt}
            subtitle={name ? excerptText : undefined}
            subtitleLines={1}
            detail={formatMemoryDate(hit.createdAtToMs)}
            showChevron={false}
            onPress={() => onOpen(hit)}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    field: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingBottom: theme.space.s6,
    },
    count: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    hitTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    hitExcerpt: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    notice: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
    },
    hint: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingTop: theme.space.s8,
    },
    retired: {
        color: theme.colors.text.tertiary,
    },
}));
