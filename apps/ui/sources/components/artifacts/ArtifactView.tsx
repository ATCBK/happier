import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { WIDGET_DEFINITION_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/widgets';

import { Redirect, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { sync } from '@/sync/sync';
import type { ArtifactViewRead } from '@/sync/engine/artifacts/syncArtifacts';
import { t } from '@/text';

import {
    artifactViewRoute,
    classifyArtifactBrowserKind,
    readArtifactCodeLanguage,
    readArtifactProvenance,
    opensInArtifactView,
    resolveArtifactOpenRoute,
} from './artifactBrowserModel';
import { artifactKindFact } from './artifactKindPresentation';
import { ArtifactProvenanceLabel } from './ArtifactProvenance';
import { useArtifactOperations } from './useArtifactOperations';
import { useArtifactBody } from './useArtifactBody';
import { ArtifactBinaryBody } from './ArtifactBinaryBody';
import { ArtifactHtmlBody } from './ArtifactHtmlBody';
import { ArtifactWidgetBody } from './ArtifactWidgetBody';
import { ArtifactPassageSelection, type ArtifactPassageMargin } from './ArtifactPassageSelection';
import { showArtifactPassageRefineSheet } from './ArtifactPassageRefineSheet';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useDocCollaboration, type DocCollaboration } from './useDocCollaboration';
import { clearDocReturn, peekDocReturn, trackDocScroll } from './docThreadReturn';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ScrollView, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

function bodyMarkdown(artifact: DecryptedArtifact): string | null {
    const body = artifact.body;
    if (typeof body !== 'string' || body.length === 0) return null;
    const language = readArtifactCodeLanguage(artifact);
    // A code document renders through the one Markdown code-block owner, never a second highlighter.
    return language ? `\`\`\`${language.toLowerCase()}\n${body}\n\`\`\`` : body;
}

/**
 * One artifact, read: in the browser's details pane (`pane`: the pane band carries the title) or as
 * its own page (`page`: the entity header). Edit, History, Share and ⋯ Delete act on it; Share is the
 * one document share sheet for every ordinary kind.
 */
export function ArtifactView(props: Readonly<{
    artifactId: string;
    /** The store's artifact for `artifactId` (`null` when it is not, or no longer, there). */
    artifact: DecryptedArtifact | null;
    presentation: 'pane' | 'page';
    onDeleted?: () => void;
}>): React.ReactElement {
    // Retained browser selections can bypass the click-time destination check.
    // Delegate before mounting any Document reader, including for a cached body.
    if (props.artifact && !opensInArtifactView(props.artifact)) {
        return <Redirect href={resolveArtifactOpenRoute(props.artifact) as Href} />;
    }
    return <ArtifactDocumentView {...props} />;
}

function ArtifactDocumentView(props: React.ComponentProps<typeof ArtifactView>): React.ReactElement {
    const { artifact } = props;
    const body = useArtifactBody(props.artifactId, artifact);
    const collaboration = useDocCollaboration(body.state === 'failed' || body.state === 'loading' ? null : (body.result?.artifact ?? artifact));
    const scope = useActiveServerAccountScope();
    const menuKey = collaboration && scope ? JSON.stringify([scope.serverId, scope.accountId, props.artifactId]) : null;
    const [threadMenu, setThreadMenu] = React.useState<Readonly<{ key: string | null; open: boolean }>>({ key: null, open: false });
    const onThreadMenuOpenChange = React.useCallback((open: boolean) => setThreadMenu({ key: menuKey, open }), [menuKey]);
    const openThreadList = React.useCallback(() => onThreadMenuOpenChange(true), [onThreadMenuOpenChange]);
    const threadMenuOpen = menuKey !== null && threadMenu.key === menuKey && threadMenu.open;
    // Preserve the former conditional menu's unmount lifetime after lifting its
    // single open state to the Doc owner; a later Doc must not inherit it.
    React.useEffect(() => {
        setThreadMenu(current => current.key === menuKey ? current : { key: menuKey, open: false });
    }, [menuKey]);
    const margin = React.useMemo(() => collaboration ? { ...collaboration.margin, onOpenThreadList: openThreadList } : undefined,
        [collaboration?.margin, openThreadList]);
    const styles = stylesheet;
    // Back from a passage's thread lands where the reader was (lab K1-Ap/Rp).
    const scroller = React.useRef<ScrollView>(null);
    const [restoreTo] = React.useState(() => peekDocReturn(props.artifactId));
    const restored = React.useRef(restoreTo === null);
    React.useEffect(() => clearDocReturn(props.artifactId), [props.artifactId]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        trackDocScroll(props.artifactId, event.nativeEvent.contentOffset.y);
    }, [props.artifactId]);
    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        if (restored.current || restoreTo === null || height < restoreTo) return;
        restored.current = true;
        scroller.current?.scrollTo({ y: restoreTo, animated: false });
    }, [restoreTo]);
    // While a Doc has threads its page takes the wide column: the body keeps its reading measure on the
    // left and the threads sit in a margin beside it (lab K1-A/R).
    const withThreads = (collaboration?.threads.length ?? 0) > 0;

    if (artifact === null) {
        return (
            <SurfaceStateCard
                testID="artifact:notFound"
                kind="empty"
                title={t('artifacts.notFound')}
                reason={t('shareSheet.documents.errors.notFound')}
            />
        );
    }
    if (artifact.isDecrypted === false) {
        return (
            <SurfaceStateCard
                testID="artifact:locked"
                kind="warning"
                title={t('settingsAccount.restoreRequiredTitle')}
                reason={artifact.availability.reason === 'encryption_material_unavailable' ? t('settingsAccount.secretKeyMissing') : t('artifacts.error')}
            />
        );
    }

    const content = body.state === 'failed' ? (
        <SurfaceStateCard
            testID="artifact:bodyFailed"
            kind="error"
            title={t('artifacts.error')}
            reason={t('artifacts.browser.loadFailedBody')}
            action={{ label: t('common.retry'), onPress: body.retry }}
            accessibilitySemantics="alert"
        />
    ) : body.state === 'loading' ? (
        <View style={styles.bodyPlaceholder} testID="artifact:bodyLoading" />
    ) : (
        <ArtifactBody artifact={body.result?.artifact ?? artifact} prepared={body.result} onRetry={body.retry} margin={margin} />
    );

    if (props.presentation === 'pane') {
        return (
            <ItemList testID="artifact:pane">
                <View style={styles.paneColumn}>
                    <ArtifactFacts artifact={artifact} collaboration={collaboration} />
                    <ArtifactActions artifact={artifact} presentation="pane" onDeleted={props.onDeleted} collaboration={collaboration}
                        threadMenuOpen={threadMenuOpen} onThreadMenuOpenChange={onThreadMenuOpenChange} />
                    <View style={styles.paneRule} />
                    {content}
                </View>
            </ItemList>
        );
    }
    return (
        <ItemList testID="artifact:page" ref={scroller} pageColumn={withThreads ? 'wide' : 'reading'}
            onScroll={onScroll} scrollEventThrottle={64} onContentSizeChange={onContentSizeChange}>
            <ArtifactPageHeader artifact={artifact} collaboration={collaboration} />
            <ItemGroup surface="none">
                {/* The title keeps the whole column; the artifact's operations sit under its facts, as in the pane. */}
                <ArtifactActions artifact={artifact} presentation="page" onDeleted={props.onDeleted} collaboration={collaboration}
                    threadMenuOpen={threadMenuOpen} onThreadMenuOpenChange={onThreadMenuOpenChange} />
                <View style={styles.paneRule} />
                {content}
            </ItemGroup>
        </ItemList>
    );
}

function ArtifactBody(props: Readonly<{ artifact: DecryptedArtifact; prepared: ArtifactViewRead | null; onRetry: () => void; margin?: ArtifactPassageMargin }>) {
    if (isArtifactHtmlHeaderV1(props.artifact.rawHeader ?? props.artifact.header)) return <ArtifactHtmlBody
        artifactId={props.artifact.id} headerVersion={props.artifact.headerVersion} bodyVersion={props.artifact.bodyVersion}
        body={props.artifact.body} name={props.artifact.title || t('artifacts.untitled')} readPreview={sync.fetchArtifactHtmlPreview}
        preview={props.prepared?.htmlPreview} onRetry={props.onRetry} />;
    // A saved widget reads as the widget itself, through the one widget surface owner.
    if ((props.artifact.rawHeader ?? props.artifact.header)?.kind === WIDGET_DEFINITION_ARTIFACT_KIND_V1) return <ArtifactWidgetBody
        artifactId={props.artifact.id} bodyVersion={props.artifact.bodyVersion} />;
    if (props.artifact.body !== null && typeof props.artifact.body === 'object') return <ArtifactBinaryBody
        artifactId={props.artifact.id} reference={props.artifact.body} name={props.artifact.title || t('artifacts.untitled')} readBytes={sync.fetchArtifactBinary}
        initialBytes={props.prepared?.binaryBytes} onRetry={props.onRetry} />;
    const markdown = bodyMarkdown(props.artifact);
    if (markdown === null) return <Text style={stylesheet.noContent}>{t('artifacts.noContent')}</Text>;
    const body = <MarkdownView testID="artifact:body" markdown={markdown} />;
    // Only a document's own Markdown is a passage source; a code document's fence is presentation.
    if (readArtifactCodeLanguage(props.artifact) || props.artifact.bodyVersion === undefined) return body;
    return <ArtifactPassageSelection artifactId={props.artifact.id} markdown={markdown}
        revision={{ headerVersion: props.artifact.headerVersion, bodyVersion: props.artifact.bodyVersion }}
        margin={props.margin} onRequestNativeSelection={showArtifactPassageRefineSheet} />;
}

function readFacts(artifact: DecryptedArtifact, collaboration: DocCollaboration | null): readonly PageHeaderMetaFact[] {
    const kind = artifactKindFact(classifyArtifactBrowserKind(artifact) ?? 'document', readArtifactCodeLanguage(artifact));
    // A Doc names the edit that made this version (lab K1-R) instead of a bare edit age.
    const accepted = collaboration?.accepted ?? null;
    const audience = collaboration?.audience ?? null;
    // A Doc with collaboration leads with the version being read and ends with who it reaches (K1-R);
    // a fact that is not known yet is left out rather than guessed.
    const lead: PageHeaderMetaFact = collaboration && collaboration.version !== null
        ? { key: 'version', text: t('artifacts.browser.facts.version', { n: collaboration.version }), icon: kind.icon }
        : { key: 'kind', text: kind.label, icon: kind.icon };
    return [
        lead,
        accepted
            ? { key: 'accepted', text: t('artifacts.browser.facts.acceptedEdit', { who: accepted.label, age: formatRelativeTimeShort(accepted.atMs, Date.now()) }) }
            : { key: 'edited', text: t('artifacts.browser.facts.edited', { age: formatRelativeTimeShort(artifact.updatedAt, Date.now()) }) },
        ...(audience === null ? [] : [audience.shared
            ? { key: 'audience', icon: 'users' as const, text: audience.team
                ? t('artifacts.browser.facts.sharedWithTeam', { team: audience.team })
                : t('artifacts.browser.facts.shared') }
            : { key: 'audience', icon: 'lock' as const, text: t('artifacts.browser.facts.onlyYou') }]),
    ];
}

/** Where it came from: a real source, or (outside a Doc's audience line) who saved it. */
function ArtifactProvenanceChip(props: Readonly<{ artifact: DecryptedArtifact; collaboration: DocCollaboration | null }>) {
    const provenance = readArtifactProvenance(props.artifact);
    // A Doc's audience line already says whose it is and who has it; the fallback chip would repeat it.
    if (provenance === null && props.collaboration) return null;
    return (
        <ArtifactProvenanceLabel
            provenance={provenance}
            fallback={props.artifact.access && props.artifact.access !== 'owner' ? t('artifacts.browser.provenance.sharedWithYou') : t('artifacts.browser.provenance.savedByYou')}
            presentation="chip"
            testID="artifact:provenance"
        />
    );
}

/** The pane's identity line: where it came from, then its kind and age (the pane band holds the title). */
function ArtifactFacts(props: Readonly<{ artifact: DecryptedArtifact; collaboration: DocCollaboration | null }>) {
    const styles = stylesheet;
    const facts = readFacts(props.artifact, props.collaboration);
    return (
        <View style={styles.facts}>
            <ArtifactProvenanceChip artifact={props.artifact} collaboration={props.collaboration} />
            <Text style={styles.factLine}>{facts.map((fact) => fact.text).join(' · ')}</Text>
        </View>
    );
}

function ArtifactPageHeader(props: Readonly<{ artifact: DecryptedArtifact; collaboration: DocCollaboration | null }>) {
    return (
        <PageHeader
            testID="artifact:header"
            title={props.artifact.title || t('artifacts.untitled')}
            alwaysShowTitle
            meta={readFacts(props.artifact, props.collaboration)}
            details={readArtifactProvenance(props.artifact) === null && props.collaboration ? undefined : (
                <View style={stylesheet.headerDetails}>
                    <ArtifactProvenanceChip artifact={props.artifact} collaboration={props.collaboration} />
                </View>
            )}
        />
    );
}

/** Edit and History quiet, Share bordered, rare operations (Delete) behind ⋯ — in the pane and on the page. */
function ArtifactActions(props: Readonly<{ artifact: DecryptedArtifact; presentation: 'pane' | 'page'; onDeleted?: () => void; collaboration: DocCollaboration | null;
    threadMenuOpen: boolean; onThreadMenuOpenChange: (open: boolean) => void }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const { artifact } = props;
    const { canEdit, canManage, canShare, deleting, remove, history, share } = useArtifactOperations(artifact, props.onDeleted ?? router.back);
    const menu: PageHeaderMenuAction[] = canManage ? [
        { id: 'delete', title: t('artifacts.delete'), destructive: true, loading: deleting, testID: 'artifact:delete', onSelect: remove },
    ] : [];
    return (
        <View style={[styles.actions, props.presentation === 'pane' ? styles.paneActions : null]} testID="artifact:actions">
            {/* Only a text document opens the text editor; a saved widget is edited where it lives. */}
            {canEdit && classifyArtifactBrowserKind(artifact) !== 'widget' && (artifact.body === undefined || artifact.body === null || typeof artifact.body === 'string') ? (
                <RoundButton
                    testID="artifact:edit"
                    size="small"
                    display="inverted"
                    title={t('artifacts.browser.actions.edit')}
                    leading={<Icon name="pencil-simple" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary }}
                    onPress={() => router.push(`/artifacts/edit/${encodeURIComponent(artifact.id)}` as never)}
                />
            ) : null}
            {props.collaboration ? <ArtifactThreadsMenu collaboration={props.collaboration} open={props.threadMenuOpen} onOpenChange={props.onThreadMenuOpenChange} /> : null}
            <RoundButton
                testID="artifact:history"
                size="small"
                display="inverted"
                title={t('artifacts.browser.actions.history')}
                leading={<Icon name="clock-counter-clockwise" size={14} color={theme.colors.text.secondary} />}
                textStyle={{ color: theme.colors.text.secondary }}
                onPress={history}
            />
            {canShare ? (
                <RoundButton
                    testID="artifact:share"
                    size="small"
                    display="secondary"
                    title={t('artifacts.browser.actions.share')}
                    leading={<Icon name="share" size={14} color={theme.colors.text.primary} />}
                    onPress={share}
                />
            ) : null}
            {menu.length > 0 ? <PageHeaderMenu testID="artifact:more" actions={menu} /> : null}
        </View>
    );
}

/**
 * The comment count, and the Doc's threads behind it: each names its passage and who started it; a
 * thread whose passage changed says so. Choosing one shows it beside its passage, or opens it.
 */
function ArtifactThreadsMenu(props: Readonly<{ collaboration: DocCollaboration; open: boolean; onOpenChange: (open: boolean) => void }>) {
    const { theme } = useUnistyles();
    const { collaboration, open, onOpenChange: setOpen } = props;
    const items = React.useMemo(() => collaboration.threads.map((thread) => ({
        id: thread.id,
        testID: `artifact:comments.thread:${thread.id}`,
        title: thread.quote,
        subtitle: t('artifacts.browser.passage.threadDetail', { who: thread.author, n: thread.replies }),
        ...(thread.changed ? { rightElement: (
            <Text variant="meta" emphasis="medium" style={{ color: theme.colors.state.warning.textForeground }}>
                {t('artifacts.browser.passage.changed')}
            </Text>
        ) } : {}),
    })), [collaboration.threads, theme.colors.state.warning.textForeground]);
    const count = collaboration.openCommentCount;
    return (
        <DropdownMenu
            testID="artifact:comments.menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            allowEmptySelection
            onSelect={(id) => {
                setOpen(false);
                collaboration.selectThread(id);
            }}
            placement="bottom"
            // A body tap far down the Doc opens this list too: a phone shows it as a sheet, never anchored off-screen.
            popoverPhonePresentation="sheet"
            popoverAccessibilityLabel={t('artifacts.browser.passage.threadsTitle')}
            popoverAnchorAlign="start"
            matchTriggerWidth={false}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <RoundButton
                    testID="artifact:comments"
                    size="small"
                    display="inverted"
                    // Unknown stays unknown (an em dash with its cause), never a zero.
                    title={count === null ? '—' : String(count)}
                    accessibilityLabel={count === null
                        ? t('artifacts.browser.passage.countUnavailable')
                        : t('artifacts.browser.passage.count', { count })}
                    leading={<Icon name="chat-circle" size={14} color={theme.colors.text.secondary} />}
                    textStyle={{ color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] }}
                    disabled={items.length === 0}
                    onPress={toggle}
                />
            )}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    paneColumn: {
        paddingHorizontal: theme.space.s24,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s32,
    },
    facts: {
        gap: theme.space.s8,
    },
    factLine: {
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    paneActions: {
        marginTop: 14,
    },
    paneRule: {
        height: 1,
        backgroundColor: theme.colors.border.subtle,
        marginTop: 14,
        marginBottom: theme.space.s16,
    },
    headerDetails: {
        marginTop: theme.space.s10,
    },
    bodyPlaceholder: {
        minHeight: 160,
    },
    noContent: {
        fontSize: 14,
        color: theme.colors.text.tertiary,
    },
}));
