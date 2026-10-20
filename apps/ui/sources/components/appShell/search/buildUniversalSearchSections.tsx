import * as React from 'react';
import { rankHappierQueryMatches } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import type {
    SelectionListDynamicSection,
    SelectionListOption,
    SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ConversationHitSummary, resolveConversationHitSnippet } from '@/components/sessions/external/browse/ConversationHitSummary';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { splitKeybindingLabel, useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SelectionListOptionStateContext } from '@/components/ui/selectionList/SelectionListOptionStateContext';
import { SelectionListDetailPaneContext } from '@/components/ui/selectionList';
import { useCodeTextFile } from '@/components/projects/files/code/useCodeTextFile';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { UniversalSearchSourceFocus } from './UniversalSearchRuntimeContext';
import { boundedReplyHints } from './searchBoundedReplyHints';

const EMPTY_WORKSPACE_SCOPE: WorkspaceScopeBase = { serverId: '', machineId: '', rootPath: '' };

import type { Command } from '@/components/appShell/commandPalette/types';
import {
    buildCommandPaletteOptionId,
    buildCommandPaletteSelectionListSections,
} from '@/components/appShell/commandPalette/buildCommandPaletteSelectionListSections';

import {
    UNIVERSAL_SEARCH_SOURCE_IDS,
    UNIVERSAL_SEARCH_PAGE_SIZE,
    buildUniversalSearchOptionId,
    buildUniversalSearchScopeKey,
    type UniversalSearchResult,
} from './universalSearchResult';

/**
 * The one Universal Search section builder.
 *
 * It is a THIN ADAPTER LAYER over canonical domain owners, and deliberately not
 * a registry: every built-in source is an ordinary branch here, resolved from
 * inputs the controller already fetched from that domain's own owner. There is
 * no registration API, no provider lifecycle, no ranking service and no cache —
 * `SelectionList` and `useSelectionListDynamicSections` remain the single owners
 * of query state, debounce, `AbortController`, stale-response fencing, section
 * status and virtualization.
 *
 * Two rules shape everything below.
 *
 * EMPTY QUERY IS A UI STATE, NOT A WIRE REQUEST. Every remote/corpus section
 * declares `visibleWhen: query is non-empty`, so opening Search issues zero
 * requests: the user sees bounded local recents and the command catalog.
 *
 * PROVIDER ORDER IS PRESERVED WHERE A CANONICAL EXECUTOR ALREADY RANKED. FTS,
 * fuzzy settings, file and commit sections declare `resultFiltering: 'provider'`
 * — re-running the host matcher over displayed labels would drop a legitimately
 * relevant row whose title does not literally contain the query. No raw score
 * from two different providers is ever compared, because no score reaches here.
 */

/** Bounded empty-query recents. Not a ranking service — just "what you had open". */
const EMPTY_QUERY_RECENT_LIMIT = 5;
/** Lines the inline Text in files group shows before its "All N matches" row (lab G1: "the best few"). */
const INLINE_FILE_CONTENT_LINES = 3;
export const EXTERNAL_CONVERSATION_SEARCH_OPTION_ID = 'external-conversations:search';
export const ALL_FILE_MATCHES_OPTION_ID = 'fileContent:all-matches';
export const MORE_FILES_OPTION_ID = 'files:more';

export type UniversalSearchSessionEntity = Readonly<{
    sessionId: string;
    serverId: string;
    accountId: string;
    title: string;
    subtitle?: string;
    searchText?: string;
    exactSearchText?: string;
    updatedAt: number;
}>;

export type UniversalSearchProjectEntity = Readonly<{
    workspaceRefId: string;
    serverId: string;
    accountId: string;
    machineId: string;
    rootPath: string;
    title: string;
    subtitle?: string;
    lastOpenedAtMs: number;
}>;

export type UniversalSearchSettingsPageEntity = Readonly<{
    id: string;
    route: string;
    title: string;
    subtitle?: string;
}>;

/**
 * A dynamic source the controller already bound to its exact target.
 *
 * `resolverKey` is the target identity — Account scope, Home/server, machine,
 * workspace root, generation. Changing it is how a superseded target's in-flight
 * work is dropped and how its rows are prevented from being replayed from the
 * cross-mount dynamic-section cache after a logout or Account switch.
 */
export type UniversalSearchDynamicSource = Readonly<{
    resolverKey: string;
    loadMore?(): void;
    /** Calm source-owned coverage/truncation context rendered by SelectionList. */
    resultHint?: string;
    resolve: (query: string, signal: AbortSignal, onProgress?: (page: Readonly<{
        results: readonly UniversalSearchResult[];
        emptyHint?: string;
        resultHint?: string;
        hasMore?: boolean;
    }>) => void) => Promise<
        readonly UniversalSearchResult[]
        | Readonly<{
            results: readonly UniversalSearchResult[];
            emptyHint?: string;
            resultHint?: string;
            hasMore?: boolean;
        }>
    >;
}>;

function isUniversalSearchResolvePage(
    value: readonly UniversalSearchResult[] | Readonly<{
        results: readonly UniversalSearchResult[];
        emptyHint?: string;
        resultHint?: string;
        hasMore?: boolean;
    }>,
): value is Readonly<{
    results: readonly UniversalSearchResult[];
    emptyHint?: string;
    resultHint?: string;
    hasMore?: boolean;
}> {
    return typeof value === 'object' && value !== null && 'results' in value;
}

/**
 * A source that exists but currently cannot answer.
 *
 * It renders as an empty section carrying the canonical typed reason as a hint —
 * never as a disabled fake row that could receive activation, and never as an
 * error, because "memory search is off" is not a failure.
 */
export type UniversalSearchUnavailableSource = Readonly<{
    resolverKey: string;
    hint: string;
}>;

export type UniversalSearchSource =
    | (Readonly<{ status: 'ready' }> & UniversalSearchDynamicSource)
    | (Readonly<{ status: 'unavailable' }> & UniversalSearchUnavailableSource)
    /** The source has no target at all here (no workspace, no admitted provider): omit it. */
    | Readonly<{ status: 'absent' }>;

export type UniversalSearchFolderSuggestion = Readonly<{
    id: string;
    name: string;
    subtitle?: string;
    onSelect: () => void;
}>;

/** Rows that change the palette's scope in place; the surface keeps the palette open for them. */
export const FILE_CONTENT_FOLDER_OPTION_PREFIX = 'fileContent:folder:';

export type BuildUniversalSearchSectionsInput = Readonly<{
    query: string;
    commands: readonly Command[];
    sessions: readonly UniversalSearchSessionEntity[];
    sessionInventoryStatus?: 'idle' | 'loading' | 'ready' | 'error';
    projects: readonly UniversalSearchProjectEntity[];
    /** The resolved settings catalog's own Fuse owner; never a second matcher. */
    searchSettingsPages: (query: string) => readonly UniversalSearchSettingsPageEntity[];
    transcript: UniversalSearchSource;
    files: UniversalSearchSource;
    fileContent?: UniversalSearchSource;
    fileContentScopeLabel?: string;
    /**
     * With no folder in scope (lab ST "No folder in scope"), the recent folders Text in files can search,
     * most recent first; choosing one scopes the search there and keeps the query.
     */
    fileContentFolders?: ReadonlyArray<UniversalSearchFolderSuggestion>;
    onShowAllFileMatches?: () => void;
    source?: UniversalSearchSourceFocus;
    symbols?: UniversalSearchSource;
    recentFiles?: readonly UniversalSearchResult[];
    changedFiles?: readonly UniversalSearchResult[];
    filesStatusHint?: string;
    commits: UniversalSearchSource;
    /** Already-built plugin provider sections; this module adds no plugin policy. */
    pluginSections: readonly SelectionListDynamicSection[];
    /** Explicit activation only: typing in Search never scans Agent transcripts. */
    externalConversationSearch?: Readonly<{
        /** The one machine the scan runs on; absent when it runs on every machine in scope. */
        machineLabel?: string;
        standardSearchEnabled?: boolean;
        onSearch(query: string): void;
    }>;
    /**
     * Records the selected identity. It deliberately does NOT navigate: the
     * option-level callback runs BEFORE the list-level `onSelect`, and plan
     * §4.2 requires commit → dismiss → awaited activation in that order. The
     * surface owns the dismissal and the awaited activation that follow.
     */
    onCommitResult: (result: UniversalSearchResult) => void;
    rowLimit?: number;
}>;

function icon(name: IconName): () => React.ReactElement {
    return () => <Icon name={name} size={ICON_SIZE.md} />;
}

/** Leading code kept before a match deep in a long line, so the match itself stays on screen. */
const SNIPPET_LEAD_CHARS = 32;

/**
 * The matching line under a Text-in-files hit (Find lab `.fd-snip`): one quiet mono line, indentation
 * dropped, the match marked with the Find tint every surface uses, and a long lead elided so the match
 * shows. The row's label already names `path:line`.
 */
type FileContentMatch = NonNullable<UniversalSearchResult['fileContent']>;
/** Every match on one line (the line's row marks them all), in column order. */
type FileContentLine = FileContentMatch & Readonly<{ columns: readonly Readonly<{ column16: number; length16: number }>[] }>;

function FileContentSnippet({ match }: Readonly<{ match: FileContentLine }>): React.ReactElement {
    const { theme } = useUnistyles();
    const start = Math.max(0, match.column16 - 1);
    const lead = match.text.slice(0, start).trimStart();
    const shownLead = lead.length > SNIPPET_LEAD_CHARS + 8 ? `…${lead.slice(-SNIPPET_LEAD_CHARS)}` : lead;
    const text = `${shownLead}${match.text.slice(start)}`;
    const ranges = match.columns.map((column) => ({ start: shownLead.length + column.column16 - 1 - start,
        end: shownLead.length + column.column16 - 1 - start + column.length16, current: false }));
    return (
        <View style={{ marginTop: theme.space.s2 }}>
            <Text useDefaultTypography={false} numberOfLines={1} style={{ ...Typography.variant('meta'), ...Typography.mono(), color: theme.colors.text.secondary }}>
                <FindHighlightedText text={text} ranges={ranges} />
            </Text>
        </View>
    );
}

/**
 * Only the active hit expands, inside its own row (it replaces the one-line snippet, so the line is never
 * shown twice); context comes from the same search response (G1s). Common indentation is dropped and the
 * line numbers sit in one right-aligned gutter (lab `.fd-snip .ln`), so 9 → 10 never shifts the code.
 */
function FileContentPreview({ match, gutterDigits, tone = 'secondary', wrap = false, bandHit = false }: Readonly<{ match: FileContentLine; gutterDigits?: number; tone?: 'primary' | 'secondary'; wrap?: boolean;
    /** The detail column also lays a quiet band under the hit line (lab G1s line 23). */
    bandHit?: boolean }>) {
    const { theme } = useUnistyles();
    const lines = [...match.before, match.text, ...match.after];
    const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length));
    const textStyle = { ...Typography.variant('meta'), ...Typography.mono(), color: tone === 'primary' ? theme.colors.text.primary : theme.colors.text.secondary };
    const digits = gutterDigits ?? String(match.line + match.after.length).length;
    const gutter = { minWidth: Math.ceil(digits * (textStyle.fontSize ?? 12) * 0.6), textAlign: 'right' as const };
    return <View testID="file-content-preview" style={{ marginTop: theme.space.s2 }}>
        {lines.map((text, index) => <View key={index} style={[{ flexDirection: 'row', gap: theme.space.s8 },
            bandHit && index === match.before.length ? { backgroundColor: theme.colors.state.active.background, borderRadius: 4, marginHorizontal: -4, paddingHorizontal: theme.space.s4 } : null]}>
            <Text useDefaultTypography={false} style={[textStyle, gutter, { color: theme.colors.text.tertiary }]}>{match.line - match.before.length + index}</Text>
            <Text useDefaultTypography={false} numberOfLines={wrap ? undefined : 1} style={[textStyle, { flex: 1 }]}>
                <FindHighlightedText text={text.slice(Math.min(indent, text.length - text.trimStart().length))} ranges={index === match.before.length
                    ? match.columns.map((column) => ({ start: column.column16 - 1 - indent, end: column.column16 - 1 - indent + column.length16, current: true }))
                    : undefined} />
            </Text>
        </View>)}
    </View>;
}

/**
 * Whether this row shows its context inline: it is the active row, and the list has no detail column
 * beside it (on a wide card the context lives there instead, lab G1s).
 */
function useRowFocused(): boolean {
    const focused = React.useContext(SelectionListOptionStateContext)?.focused === true;
    const inPane = React.useContext(SelectionListDetailPaneContext);
    return focused && !inPane;
}

/** The detail column for a line hit (lab G1s `.fd-preview`): which file and line, its context, and what Return does. */
/** Lines kept around the hit in the detail column (lab G1s shows about a dozen, the hit near the top third). */
const DETAIL_LINES_BEFORE = 5;
const DETAIL_LINES_AFTER = 6;

/**
 * The excerpt the detail column shows: the file read through the workspace file owner when it still has
 * the hit on that line, else the context the search itself returned (a file edited since the search, a
 * read that failed or is still on its way).
 */
function useFileContentExcerpt(match: FileContentLine, scope: WorkspaceScopeBase | null): FileContentLine {
    const file = useCodeTextFile(scope ?? EMPTY_WORKSPACE_SCOPE, scope ? match.path : null);
    return React.useMemo(() => {
        if (file.kind !== 'ready') return match;
        const lines = file.text.split(/\r?\n/);
        if (lines[match.line - 1] !== match.text) return match;
        return { ...match,
            before: lines.slice(Math.max(0, match.line - 1 - DETAIL_LINES_BEFORE), match.line - 1),
            after: lines.slice(match.line, match.line + DETAIL_LINES_AFTER) };
    }, [file, match]);
}

function FileContentDetail({ match: hit, scope }: Readonly<{ match: FileContentLine; scope: WorkspaceScopeBase | null }>) {
    const { theme } = useUnistyles();
    const match = useFileContentExcerpt(hit, scope);
    const split = Math.max(match.path.lastIndexOf('/'), match.path.lastIndexOf('\\'));
    const name = match.path.slice(split + 1);
    return <View testID="file-content-detail" style={{ paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingVertical: MENU_ROW_METRICS.paddingVerticalPx, gap: theme.space.s10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: MENU_ROW_METRICS.iconMarginRightPx }}>
            <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
            <Text numberOfLines={1} style={[Typography.variant('label', 'semiBold'), { flexShrink: 1, color: theme.colors.text.primary }]}>
                <Text style={Typography.default('medium')}>{name}</Text>
                <Text style={[Typography.default(), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{`  · ${t('universalSearch.content.atLine', { line: match.line })}`}</Text>
            </Text>
        </View>
        {/* The column has room to show whole lines (lab G1s wraps them). */}
        <FileContentPreview match={match} tone="primary" wrap bandHit />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 }}>
            <KeyHint label="↵" />
            <Text style={[Typography.variant('meta'), { color: theme.colors.text.tertiary }]}>{t('commandPalette.hints.openAtLine')}</Text>
        </View>
    </View>;
}

/** A Text-in-files hit's second line: the matching line, or its context while the row is active. */
function FileContentSubtitle({ match }: Readonly<{ match: FileContentLine }>) {
    const focused = useRowFocused();
    return focused && (match.before.length > 0 || match.after.length > 0)
        ? <FileContentPreview match={match} />
        : <FileContentSnippet match={match} />;
}

/**
 * A deep directory keeps its first two and last folders around an ellipsis (lab G1 `apps/ui/…/settings/`),
 * so the file name stays readable at any width; web text cannot ellipsize at the head.
 */
function compactDirectory(directory: string): string {
    const parts = directory.split(/[\\/]/).filter(Boolean);
    return parts.length > 3 ? `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}/` : directory;
}

/** File identity keeps its directory quiet, its name readable and its line tabular (lab G1). */
function FileContentLabel({ match }: Readonly<{ match: FileContentMatch }>) {
    const { theme } = useUnistyles();
    const split = Math.max(match.path.lastIndexOf('/'), match.path.lastIndexOf('\\'));
    return <Text numberOfLines={1} ellipsizeMode="head" style={[Typography.variant('label', 'semiBold'), { color: theme.colors.text.primary }]}>
        <Text style={[Typography.default(), { color: theme.colors.text.tertiary }]}>{compactDirectory(match.path.slice(0, split + 1))}</Text>
        <Text style={Typography.default('medium')}>{match.path.slice(split + 1)}</Text>
        <Text style={[Typography.default(), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{`:${match.line}`}</Text>
    </Text>;
}

/** The Text in files scope's file heading (lab G1s): type mark, name, quiet folder, match count right. */
function FileContentGroupHeader({ path, matches }: Readonly<{ path: string; matches: number }>) {
    const { theme } = useUnistyles();
    const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: MENU_ROW_METRICS.iconMarginRightPx,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingTop: MENU_ROW_METRICS.paddingVerticalPx, paddingBottom: theme.space.s2 }}>
        <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx, alignItems: 'center' }}><FileIcon fileName={path.slice(split + 1)} size={ICON_SIZE.sm} appearance="line" /></View>
        <Text numberOfLines={1} ellipsizeMode="head" style={[Typography.variant('label', 'semiBold'), { flex: 1, color: theme.colors.text.primary }]}>
            <Text style={Typography.default('medium')}>{path.slice(split + 1)}</Text>
            {split >= 0 ? <Text style={[Typography.default(), { color: theme.colors.text.tertiary }]}>{`  ${compactDirectory(path.slice(0, split)).replace(/\/$/, '')}`}</Text> : null}
        </Text>
        <Text style={[Typography.variant('meta'), Typography.tabular(), { color: theme.colors.text.tertiary }]}>{matches}</Text>
    </View>;
}

function AllMatchesLabel({ label }: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return <Text numberOfLines={1} style={[Typography.variant('meta'), { color: theme.colors.text.secondary }]}>{label}</Text>;
}

function FileContentScopeStatus({ label }: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return <Text style={[Typography.variant('meta'), Typography.tabular(), { color: theme.colors.text.secondary,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingTop: MENU_ROW_METRICS.paddingVerticalPx }]}>{label}</Text>;
}

/** A line under its file heading: the line number in a quiet gutter, then the code (lab G1s `.fd-snip`). */
function FileContentLineLabel({ match, gutterDigits }: Readonly<{ match: FileContentLine; gutterDigits: number }>) {
    const { theme } = useUnistyles();
    const focused = useRowFocused();
    if (focused && (match.before.length > 0 || match.after.length > 0)) {
        return <FileContentPreview match={match} gutterDigits={gutterDigits} tone="primary" />;
    }
    const text = match.text.trimStart();
    const shift = match.text.length - text.length;
    const ranges = match.columns.map((column) => ({ start: column.column16 - 1 - shift, end: column.column16 - 1 - shift + column.length16, current: false }));
    const style = { ...Typography.variant('meta'), ...Typography.mono() };
    // The same right-aligned gutter as the expanded context, so the code never shifts when a row becomes active.
    const gutter = { minWidth: Math.ceil(gutterDigits * (style.fontSize ?? 12) * 0.6), textAlign: 'right' as const };
    return <View style={{ flexDirection: 'row', gap: theme.space.s8 }}>
        <Text useDefaultTypography={false} style={[style, Typography.tabular(), gutter, { color: theme.colors.text.tertiary }]}>{match.line}</Text>
        <Text useDefaultTypography={false} numberOfLines={1} style={[style, { flex: 1, color: theme.colors.text.primary }]}>
            <FindHighlightedText text={text} ranges={ranges} />
        </Text>
    </View>;
}

/** Same-line matches become one line (a row per line, every match on it marked), in response order. */
function groupFileContentLines(results: readonly UniversalSearchResult[]): Array<Readonly<{ result: UniversalSearchResult; line: FileContentLine }>> {
    const lines: Array<{ result: UniversalSearchResult; line: FileContentLine }> = [];
    for (const result of results) {
        const match = result.fileContent;
        if (!match) continue;
        const last = lines[lines.length - 1];
        if (last && last.line.path === match.path && last.line.line === match.line) {
            last.line = { ...last.line, columns: [...last.line.columns, { column16: match.column16, length16: match.length16 }] };
            continue;
        }
        lines.push({ result, line: { ...match, columns: [{ column16: match.column16, length16: match.length16 }] } });
    }
    return lines;
}

function TextInFilesShortcut() {
    const shortcut = useKeyboardShortcutLabel('search.textInFiles');
    return shortcut ? <View style={{ flexDirection: 'row', gap: 3 }}>
        {splitKeybindingLabel(shortcut).map((label, index) => <KeyHint key={index} label={label} />)}
    </View> : null;
}

/** The Agent's own mark for a conversation from its history; identity marks stand alone. */
function agentIcon(agentId: string): () => React.ReactElement {
    return () => <AgentIcon agentId={agentId} size={ICON_SIZE.md} />;
}

/**
 * A file's type mark exactly as the Files tree draws it (`FileIcon` at the tree's size, `line` appearance):
 * one glyph weight and box in every palette row kind (Files rows, text-in-files headings, the preview),
 * with the type in its tint. Live over lab (filled TSX/TS/MD badges): one FileIcon owner.
 */
function fileIcon(path: string): () => React.ReactElement {
    const name = path.slice(path.lastIndexOf('/') + 1);
    // A filled type tile reads larger than a line glyph; the small size matches its optical weight.
    return () => <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />;
}

function toOption(
    result: UniversalSearchResult,
    iconName: IconName,
    onCommit: (result: UniversalSearchResult) => void,
    fileLine?: FileContentLine,
    /** The typed query: a row whose title is the text that matched tints it. */
    titleQuery?: string,
): SelectionListOption {
    return {
        id: buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id),
        testID: `universal-search:option:${result.sourceId}:${result.id}`,
        label: result.target.kind === 'workspaceFile' && !result.fileContent && result.target.anchor && 'startLine' in result.target.anchor
            // A `path:line` hit says where it lands.
            ? `${result.title}:${result.target.anchor.startLine}`
            : result.conversation ? stripMarkdown(result.title) : result.title,
        ...(result.subtitle ? { subtitle: result.subtitle } : {}),
        ...(titleQuery && !result.conversation && !result.fileContent ? { labelHighlightQuery: titleQuery } : {}),
        ...(result.fileContent ? {
            subtitleContent: () => <FileContentSubtitle match={fileLine ?? { ...result.fileContent!, columns: [result.fileContent!] }} />,
            detailContent: () => <FileContentDetail match={fileLine ?? { ...result.fileContent!, columns: [result.fileContent!] }}
                scope={result.target.kind === 'workspaceFile' ? result.target.scope : null} />,
        } : {}),
        ...(result.conversation ? {
            contentAlign: 'start' as const,
            labelHighlightQuery: result.conversation.query.trim() || undefined,
            subtitle: stripMarkdown(result.conversation.snippet),
            subtitleContent: () => <ConversationHitSummary
                snippet={resolveConversationHitSnippet({ title: result.title, snippet: result.conversation!.snippet, query: result.conversation!.query })}
                query={result.conversation!.query}
                where={result.conversation!.machineLabel} atMs={result.conversation!.atMs} />,
            // The row's spoken name is what it shows: the conversation, what matched, where.
            accessibilityLabel: [stripMarkdown(result.title), stripMarkdown(result.conversation.snippet), result.conversation.machineLabel].filter(Boolean).join(', '),
        } : {}),
        ...(result.searchText ? { searchText: result.searchText } : {}),
        ...(result.exactSearchText ? { exactSearchText: result.exactSearchText } : {}),
        ...((result.kind === 'project' || result.kind === 'workspaceFile') && result.subtitle
            ? { subtitleEllipsizeMode: 'head' as const }
            : {}),
        icon: result.conversation?.agentId ? agentIcon(result.conversation.agentId)
            : result.fileContent ? fileIcon(result.fileContent.path)
            : result.kind === 'workspaceFile' && result.target.kind === 'workspaceFile' ? fileIcon(result.target.path)
            : icon(iconName),
        onSelect: () => { onCommit(result); },
    };
}

function buildDynamicSection(
    input: Readonly<{
        sourceId: string;
        title: string;
        source: UniversalSearchSource;
        iconName: IconName;
        rowLimit?: number;
        minQueryLength?: number;
        preserveQuery?: boolean;
        scopeLabel?: string;
        onShowAll?: () => void;
        /** The Text in files scope: every line, grouped under its file (lab G1s). */
        groupByFile?: boolean;
        onCommit: (result: UniversalSearchResult) => void;
    }>,
): SelectionListDynamicSection[] {
    const { source } = input;
    if (source.status === 'absent') return [];

    if (source.status === 'unavailable') {
        return [{
            id: input.sourceId,
            title: input.title,
            rightAccessory: input.scopeLabel,
            resolverKey: `${input.sourceId}|${source.resolverKey}`,
            visibleWhen: (value: string) => (input.preserveQuery ? value.length : value.trim().length) >= (input.minQueryLength ?? 1),
            debounceMs: 0,
            loadingSkeletonRows: 0,
            showSkeletonsOnFirstLoad: true,
            resultTransition: 'none',
            // A truthful, non-activatable availability statement resolved through
            // the canonical empty-hint path. The shell and every healthy section
            // stay usable beside it.
            resolve: async () => ({ options: [], emptyHint: source.hint }),
        }];
    }

    return [{
        id: input.sourceId,
        // In the Text in files scope the token in the field names the group; the status row leads instead.
        ...(input.groupByFile ? {} : { title: input.title, rightAccessory: input.scopeLabel }),
        resolverKey: `${input.sourceId}|${source.resolverKey}`,
        visibleWhen: (value: string) => (input.preserveQuery ? value.length : value.trim().length) >= (input.minQueryLength ?? 1),
        resultFiltering: 'provider',
        showSkeletonsOnFirstLoad: true,
        // The group keeps its place and says it is still looking in one quiet line (lab ST), never a block of
        // placeholder bars taller than the results that replace them.
        loadingHint: t('universalSearch.searchingGroup'),
        errorHint: t('universalSearch.groupFailed', { group: input.title }),
        retryLabel: t('common.retry'),
        resultTransition: 'none',
        resolve: async (seed, signal, onProgress) => {
            const project = (resolved: Awaited<ReturnType<typeof source.resolve>>) => {
                const page = isUniversalSearchResolvePage(resolved)
                    ? resolved
                    : { results: resolved, emptyHint: undefined };
                // Hits arrive grouped by file; each row is one matching line and names its `path:line` (Find lab G1)
                // so any row read alone, spoken or scrolled to, still says where it lands.
                const lines = groupFileContentLines(page.results);
                const options: SelectionListOption[] = lines.length === 0
                    ? page.results.slice(0, input.rowLimit).map((result) => toOption(result, input.iconName, input.onCommit, undefined, seed.trim() || undefined))
                    : input.groupByFile
                        ? (() => {
                            // One gutter per file, as wide as its last shown line number.
                            const gutterDigitsByPath = new Map<string, number>();
                            for (const { line } of lines) {
                                gutterDigitsByPath.set(line.path, Math.max(gutterDigitsByPath.get(line.path) ?? 1, String(line.line + line.after.length).length));
                            }
                            return lines.flatMap(({ result, line }, index): SelectionListOption[] => {
                            const location = `${line.path}:${line.line}`;
                            const lineOption: SelectionListOption = {
                                ...toOption(result, input.iconName, input.onCommit, line),
                                label: location,
                                labelContent: () => <FileContentLineLabel match={line} gutterDigits={gutterDigitsByPath.get(line.path) ?? 1} />,
                                // The code is the row's title here; the file heading above says where.
                                subtitle: undefined, subtitleContent: undefined,
                                // An empty mark slot keeps the code on the file name's edge.
                                icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
                                accessibilityLabel: `${location} ${line.text.trim()}`,
                            };
                            if (index > 0 && lines[index - 1]!.line.path === line.path) return [lineOption];
                            const matches = lines.filter((entry) => entry.line.path === line.path)
                                .reduce((count, entry) => count + entry.line.columns.length, 0);
                            return [{
                                id: `${UNIVERSAL_SEARCH_SOURCE_IDS.fileContent}:file:${line.path}`,
                                label: line.path,
                                // A heading, not a choice: it reads at full strength and the keyboard passes over it.
                                disabled: true,
                                content: <FileContentGroupHeader path={line.path} matches={matches} />,
                            }, lineOption];
                        });
                        })()
                        : lines.slice(0, input.rowLimit).map(({ result, line }) => {
                            const location = `${line.path}:${line.line}`;
                            return {
                                ...toOption(result, input.iconName, input.onCommit, line),
                                label: location,
                                labelContent: () => <FileContentLabel match={line} />,
                                labelEllipsizeMode: 'head' as const,
                                accessibilityLabel: `${location} ${line.text.trim()}`,
                            };
                        });
                if (input.sourceId === UNIVERSAL_SEARCH_SOURCE_IDS.fileContent && !input.groupByFile && input.onShowAll && (options.length > 0 || page.hasMore)) {
                    const files = new Set(page.results.filter(result => result.fileContent).map(result => result.fileContent!.path)).size;
                    options.push({
                        id: ALL_FILE_MATCHES_OPTION_ID,
                        testID: 'universal-search:all-file-matches',
                        label: page.hasMore ? t('universalSearch.content.moreMatches')
                            : t('universalSearch.content.allMatches', { matches: page.results.length, files }),
                        // A summary, not a hit: set at the meta step in quiet ink, like the lab's "All 11 matches in 4 files".
                        labelContent: () => <AllMatchesLabel label={page.hasMore ? t('universalSearch.content.moreMatches')
                            : t('universalSearch.content.allMatches', { matches: page.results.length, files })} />,
                        rightAccessory: () => <TextInFilesShortcut />,
                        // An empty mark slot puts "All N matches" on the text column of the lines above (lab G1).
                        icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
                        onSelect: input.onShowAll,
                    });
                }
                if (input.sourceId === UNIVERSAL_SEARCH_SOURCE_IDS.files && page.hasMore && source.loadMore) {
                    options.push({ id: MORE_FILES_OPTION_ID, label: t('universalSearch.quickOpen.showMore'), onSelect: source.loadMore });
                }
                if (input.groupByFile && lines.length > 0) {
                    // The scope's status line (lab G1s): how much was found; the Text in files token says where.
                    options.unshift({
                        id: `${UNIVERSAL_SEARCH_SOURCE_IDS.fileContent}:status`,
                        label: t('universalSearch.content.matchesInFiles', { matches: page.results.length, files: new Set(lines.map((entry) => entry.line.path)).size }),
                        disabled: true,
                        content: <FileContentScopeStatus label={t('universalSearch.content.matchesInFiles', { matches: page.results.length, files: new Set(lines.map((entry) => entry.line.path)).size })} />,
                    });
                }
                // Inside the Text in files scope there is nowhere further to go: an incomplete page says so.
                const scopeHints = input.groupByFile ? boundedReplyHints({ rowCount: lines.length, incomplete: page.hasMore === true }) : {};
                const resultHint = page.resultHint ?? scopeHints.resultHint ?? source.resultHint;
                // Coverage still describes the searched corpus when it yields no rows.
                // SelectionList needs its empty-state hint to retain that section.
                const emptyHint = page.emptyHint ?? scopeHints.emptyHint ?? (options.length === 0 ? resultHint : undefined);
                return {
                    options,
                    ...(emptyHint !== undefined ? { emptyHint } : {}),
                    ...(resultHint !== undefined ? { resultHint } : {}),
                };
            };
            const resolved = await source.resolve(input.preserveQuery ? seed : seed.trim(), signal,
                onProgress ? page => onProgress(project(page)) : undefined);
            return project(resolved);
        },
    }];
}

function narrowLocalEntities<T>(
    entities: readonly T[],
    query: string,
    recentLimit: number,
): readonly T[] {
    // On an empty query the list is a bounded "what you had open" set. With a
    // query the host matcher does the narrowing and ranking, so every candidate
    // must be offered. SelectionList virtualizes the resulting rows; there is no
    // pre-match display cap that can hide a valid later candidate.
    return query.length === 0 ? entities.slice(0, recentLimit) : entities;
}

export function buildUniversalSearchSections(
    input: BuildUniversalSearchSectionsInput,
): ReadonlyArray<SelectionListSectionDescriptor> {
    const query = input.query.trim();
    const rowLimit = input.rowLimit ?? UNIVERSAL_SEARCH_PAGE_SIZE;
    const onCommit = input.onCommitResult;
    const sections: SelectionListSectionDescriptor[] = [];
    const scopedToContent = input.source === 'fileContent';
    if (input.source === 'symbols') return buildDynamicSection({ sourceId: 'symbols',
        title: t('settingsKeyboard.commands.searchSymbols'), source: input.symbols ?? { status: 'absent' },
        iconName: 'file', minQueryLength: 0, onCommit }).map(section => ({ kind: 'dynamic' as const, ...section }));
    if (input.source === 'files') {
        const recentIds = new Set(input.recentFiles?.map(result => buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id)));
        if (!query) {
            const groups = [
                { id: 'files:recent', title: t('universalSearch.quickOpen.recent'), results: input.recentFiles },
                { id: 'files:changed', title: t('universalSearch.quickOpen.changed'), results: input.changedFiles?.filter(result => !recentIds.has(buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id))) },
            ].flatMap(({ id, title, results }): SelectionListSectionDescriptor[] => results?.length ? [{
                kind: 'static', id, title, options: results.map(result => toOption(result, 'file', onCommit)),
            }] : []);
            if (input.filesStatusHint && groups.length > 0) return groups.map((group, index) => index === 0 ? { ...group, resultHint: input.filesStatusHint } : group);
            if (input.filesStatusHint) return buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
                title: t('universalSearch.sections.files'), source: { status: 'unavailable',
                    resolverKey: input.files.status === 'absent' ? input.filesStatusHint : input.files.resolverKey, hint: input.filesStatusHint },
                iconName: 'file', minQueryLength: 0, onCommit }).map(section => ({ kind: 'dynamic' as const, ...section }));
            return groups;
        }
        return buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files, title: t('universalSearch.sections.files'),
            source: input.files, iconName: 'file', onCommit }).map(section => ({ kind: 'dynamic' as const, ...section }));
    }
    const folders = input.fileContentFolders ?? [];
    const contentSections = (input.fileContent ?? { status: 'absent' }).status === 'absent' && folders.length > 0 && !scopedToContent
        ? [{
            kind: 'dynamic' as const,
            id: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent,
            title: t('universalSearch.content.textInFiles'),
            resolverKey: `${UNIVERSAL_SEARCH_SOURCE_IDS.fileContent}|folders|${folders.map((folder) => folder.id).join('|')}`,
            visibleWhen: (value: string) => value.length > 0,
            resultFiltering: 'provider' as const,
            debounceMs: 0,
            resultTransition: 'none' as const,
            resolve: async () => ({
                options: folders.slice(0, INLINE_FILE_CONTENT_LINES).map((folder): SelectionListOption => ({
                    id: `${FILE_CONTENT_FOLDER_OPTION_PREFIX}${folder.id}`,
                    label: t('universalSearch.content.searchInFolder', { name: folder.name }),
                    ...(folder.subtitle ? { subtitle: folder.subtitle } : {}),
                    icon: icon('folder'),
                    onSelect: folder.onSelect,
                })),
            }),
        }]
        : buildDynamicSection({ sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.fileContent, title: t('universalSearch.content.textInFiles'), source: input.fileContent ?? { status: 'absent' }, iconName: 'file', preserveQuery: true, scopeLabel: input.fileContentScopeLabel, onShowAll: input.onShowAllFileMatches, onCommit,
        // Inline (lab G1) the group shows the best few lines and then "All N matches"; the scope lists every line by file.
        ...(scopedToContent ? { groupByFile: true } : { rowLimit: INLINE_FILE_CONTENT_LINES }) }).map((section) => ({ kind: 'dynamic' as const, ...section }));
    if (scopedToContent) return contentSections;

    // Construction, currentness, availability, i18n and activation of commands
    // all stay with `buildCommandPaletteCommands`.
    const nonRecentCommands = input.commands.filter((command) => command.kind !== 'recentSession');
    const visibleCommands = query.length > 0
        ? nonRecentCommands
        : nonRecentCommands
            .filter((command) => command.emptyQuerySuggested === true);
    const commandSections = buildCommandPaletteSelectionListSections(visibleCommands);

    const sessions = narrowLocalEntities(input.sessions, query, EMPTY_QUERY_RECENT_LIMIT);
    const sessionInventoryHint = query.length > 0
        ? input.sessionInventoryStatus === 'loading'
            ? t('universalSearch.sessionInventoryLoading')
            : input.sessionInventoryStatus === 'error'
                ? t('universalSearch.sessionInventoryIncomplete')
                : undefined
        : undefined;
    const sessionSection: SelectionListSectionDescriptor | null = sessions.length > 0 || sessionInventoryHint
        ? {
            kind: 'static',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.sessions,
            title: query.length === 0
                ? t('commandPalette.commands.recentSessionsCategory')
                : t('universalSearch.sections.sessions'),
            options: sessions.map((session) => toOption({
                id: session.sessionId,
                // The same session id can exist on two Homes; the Home the row
                // was projected from is part of what the user selected.
                scopeKey: buildUniversalSearchScopeKey([session.accountId, session.serverId]),
                sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.sessions,
                kind: 'session',
                title: session.title,
                ...(session.subtitle ? { subtitle: session.subtitle } : {}),
                ...(session.searchText ? { searchText: session.searchText } : {}),
                ...(session.exactSearchText ? { exactSearchText: session.exactSearchText } : {}),
                target: {
                    kind: 'session',
                    sessionId: session.sessionId,
                    serverId: session.serverId,
                    accountId: session.accountId,
                },
            }, 'chats-circle', onCommit, undefined, query || undefined)),
            ...(sessionInventoryHint ? { resultHint: sessionInventoryHint } : {}),
        }
        : null;

    // The Settings catalog ranks and admits literal matches or title typos. Its shared row projection
    // shows the description/keyword when it explains the hit; preserve that provider order.
    const settingsPages = query.length > 0 ? input.searchSettingsPages(query).slice(0, rowLimit) : [];
    const settingsSection: SelectionListSectionDescriptor | null = settingsPages.length > 0
        ? {
            kind: 'dynamic',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.settings,
            title: t('universalSearch.sections.settings'),
            resolverKey: `${UNIVERSAL_SEARCH_SOURCE_IDS.settings}|${query}`,
            visibleWhen: (value: string) => value.trim().length > 0,
            debounceMs: 0,
            loadingSkeletonRows: 0,
            resultFiltering: 'provider',
            showSkeletonsOnFirstLoad: true,
            resultTransition: 'none',
            resolve: async () => ({
                options: settingsPages.map((page) => toOption({
                    id: page.id,
                    // Settings pages are host-local: the catalog is the scope.
                    scopeKey: buildUniversalSearchScopeKey(['settings']),
                    sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.settings,
                    kind: 'settingsPage',
                    title: page.title,
                    ...(page.subtitle ? { subtitle: page.subtitle } : {}),
                    target: { kind: 'settingsPage', route: page.route },
                }, 'sliders-horizontal', onCommit)),
            }),
        }
        : null;

    // One stable group order; a group appears only when it has rows (or a truthful hint).
    // Empty query: what you had open first, then the suggested commands (Actions, Go to).
    // With a query: matching commands, then Settings, then Sessions.
    if (query.length === 0) {
        if (sessionSection) sections.push(sessionSection);
        sections.push(...commandSections);
    } else {
        sections.push(...commandSections);
        if (settingsSection) sections.push(settingsSection);
        if (sessionSection) sections.push(sessionSection);
    }

    const projects = narrowLocalEntities(input.projects, query, EMPTY_QUERY_RECENT_LIMIT);
    if (projects.length > 0) {
        sections.push({
            kind: 'static',
            id: UNIVERSAL_SEARCH_SOURCE_IDS.projects,
            title: t('universalSearch.sections.projects'),
            options: projects.map((project) => toOption({
                id: project.workspaceRefId,
                scopeKey: buildUniversalSearchScopeKey([
                    project.accountId,
                    project.serverId,
                    project.machineId,
                    project.rootPath,
                ]),
                sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.projects,
                kind: 'project',
                title: project.title,
                ...(project.subtitle ? { subtitle: project.subtitle } : {}),
                target: {
                    kind: 'project',
                    workspaceRefId: project.workspaceRefId,
                    serverId: project.serverId,
                    accountId: project.accountId,
                    machineId: project.machineId,
                    rootPath: project.rootPath,
                },
            }, 'folder-open', onCommit, undefined, query || undefined)),
        });
    }

    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.transcript,
        title: t('universalSearch.sections.messages'),
        source: input.transcript,
        iconName: 'chat-circle-dots',
        rowLimit,
        onCommit,
    })) {
        sections.push({ kind: 'dynamic', ...section });
    }

    if (query.length > 0 && input.externalConversationSearch && input.externalConversationSearch.standardSearchEnabled !== false) {
        const search = input.externalConversationSearch;
        sections.push({
            kind: 'static',
            id: 'externalConversations',
            // Lab H1: the group names where the scan runs; the row is the one action.
            title: search.machineLabel
                ? t('externalSessions.browseContentOnMachine', { machine: search.machineLabel })
                : t('conversationSearch.scopeAllMachinesSubtitle'),
            options: [{
                id: EXTERNAL_CONVERSATION_SEARCH_OPTION_ID,
                testID: 'universal-search:external-conversations:search',
                label: t('externalSessions.browseContentPaletteSearch', { query: input.query }),
                icon: icon('chat-circle-dots'),
                onSelect: () => search.onSearch(input.query),
            }],
        });
    }

    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.files,
        title: t('universalSearch.sections.files'),
        source: input.files,
        iconName: 'file',
        onCommit,
    })) {
        sections.push({ kind: 'dynamic', ...section });
    }

    sections.push(...contentSections);
    for (const section of buildDynamicSection({
        sourceId: UNIVERSAL_SEARCH_SOURCE_IDS.commits,
        title: t('universalSearch.sections.commits'),
        source: input.commits,
        iconName: 'git-branch',
        rowLimit,
        onCommit,
    })) {
        sections.push({ kind: 'dynamic', ...section });
    }

    for (const section of input.pluginSections) {
        // Query-result motion and first-load truth are host presentation policy,
        // not plugin descriptor policy. Keep every admitted plugin section on
        // the same high-frequency Search behavior as built-in providers.
        sections.push({
            kind: 'dynamic',
            ...section,
            showSkeletonsOnFirstLoad: true,
            loadingHint: t('universalSearch.searchingGroup'),
            // A failing provider says so in host copy, like every built-in group; its message stays in logs.
            errorHint: t('universalSearch.groupFailed', { group: section.title ?? section.id }),
            retryLabel: t('common.retry'),
            resultTransition: 'none',
        });
    }

    // A named Session or Project is the reader's content. Keep its group ahead
    // of settings/commands matched by descriptions or catalog keywords, using
    // the same title matcher as SelectionList rather than another score.
    if (query.length > 0) {
        const titleMatches = new Set(sections.filter(section => section.kind === 'static'
            && (section.id === UNIVERSAL_SEARCH_SOURCE_IDS.sessions || section.id === UNIVERSAL_SEARCH_SOURCE_IDS.projects)
            && rankHappierQueryMatches(section.options, query, option => ({ label: option.label })).length > 0));
        return [...sections.filter(section => titleMatches.has(section)), ...sections.filter(section => !titleMatches.has(section))];
    }
    return sections;
}

/** Resolve the command a rendered option id refers to, if any. */
export function findCommandForOptionId(
    commands: readonly Command[],
    optionId: string,
): Command | null {
    for (const command of commands) {
        if (buildCommandPaletteOptionId(command.id) === optionId) return command;
    }
    return null;
}
