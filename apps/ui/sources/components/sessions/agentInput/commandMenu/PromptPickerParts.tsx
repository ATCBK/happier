import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { Animated, Platform, ScrollView, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { resolveOverlayMotionPreset, useOverlayMotionAnimation } from '@/components/ui/overlays/motion/overlayMotion';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { FavoriteToggleButton } from '@/components/ui/buttons/FavoriteToggleButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SELECTION_LIST_SKELETON_ROW_SHAPE } from '@/components/ui/selectionList/_constants';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { queryRanges } from '@/components/ui/text/queryRanges';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Typography } from '@/constants/Typography';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { isEscapeKeyEvent } from '@/keyboard/escape';
import { formatKeybindingLabel } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { t } from '@/text';
import type { PromptPickerRow } from './promptPickerRows';
import { useSaveMessageAsPrompt, type SaveMessageAsPromptSaved } from '@/components/sessions/transcript/messageActions/useSaveMessageAsPrompt';

type RowLabels = Readonly<{
    nowMs: number;
    folderNames: ReadonlyMap<string, string>;
    sessionNames: ReadonlyMap<string, string>;
}>;

const ARGUMENTS_TOKEN = '$ARGUMENTS';

/** `fixed` parts (a time) never lose their place to a long neighbour. */
type MetaPart = Readonly<{ text: string; token?: true; fixed?: true }>;

/** "Library · /e2e · Testing", "Built in · /review" or "Fix settings modal remount · 12m ago"; `/tokens` are marked. */
function describeRow(row: PromptPickerRow, labels: RowLabels): readonly MetaPart[] {
    if (row.kind === 'history') {
        const session = labels.sessionNames.get(row.entry.sessionId);
        // A session is usually named after its first message; that text is already the title.
        const named = session && !sharesLeadingText(session, row.title) ? [{ text: session }] : [];
        return [...named, { text: formatRelativeTimeShort(row.entry.createdAtMs, labels.nowMs), fixed: true as const }];
    }
    const tokens = row.tokens.map((text): MetaPart => ({ text, token: true }));
    if (row.kind === 'builtIn') return [{ text: t('agentInput.promptPicker.builtIn') }, ...tokens];
    const place = row.document.folderId ? labels.folderNames.get(row.document.folderId) : row.document.tags[0];
    return [{ text: t('agentInput.promptPicker.library') }, ...tokens, ...(place ? [{ text: place }] : [])];
}

const squash = (text: string) => text.replace(/\s+/g, ' ').replace(/(?:…|\.{3})$/, '').trim().toLowerCase();

/** True when one text is the start of the other, e.g. a session named from its first message. */
function sharesLeadingText(a: string, b: string): boolean {
    const [x, y] = [squash(a), squash(b)];
    return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
}

function MetaLine(props: Readonly<{ parts: readonly MetaPart[]; style: StyleProp<TextStyle>; trailing?: string; lines?: number }>) {
    const joined = (parts: readonly MetaPart[]) => parts.map((part, index) => <React.Fragment key={index}>
        {index ? ' · ' : ''}{part.token ? <Text style={styles.token}>{part.text}</Text> : part.text}
    </React.Fragment>);
    const fixed = props.parts.filter((part) => part.fixed);
    // Where the line may wrap (the preview header) every part stays in reading order; on a one-line row
    // the flowing parts give way so the fixed one (a time) always shows.
    if (!fixed.length || props.lines) {
        return <Text style={props.style} numberOfLines={props.lines ?? 1}>{joined(props.parts)}{props.trailing ? ` · ${props.trailing}` : ''}</Text>;
    }
    const flowing = props.parts.filter((part) => !part.fixed);
    return <View style={styles.metaRow}>
        {flowing.length ? <Text style={[props.style, styles.metaLead]} numberOfLines={1}>{joined(flowing)}</Text> : null}
        <Text style={props.style} numberOfLines={1}>{flowing.length ? ' · ' : ''}{fixed.map((part) => part.text).join(' · ')}</Text>
    </View>;
}

export function PromptPickerRowContent(props: RowLabels & Readonly<{
    row: PromptPickerRow;
    query: string;
    onToggleFavorite: () => void;
}>) {
    const { theme } = useUnistyles();
    const { row } = props;
    const title = row.kind === 'history' ? row.title.replace(/\s+/g, ' ').trim() : row.title;
    return <View style={styles.row} testID={`prompt-picker-row:${row.id}`}>
        <View style={styles.lead}>
            <Icon name={row.kind === 'history' ? 'clock-counter-clockwise' : 'chat'} size={16} color={theme.colors.text.secondary} />
        </View>
        <View style={styles.body}>
            <Text style={styles.title} numberOfLines={1}><FindHighlightedText text={title} ranges={queryRanges(title, props.query)} /></Text>
            <MetaLine style={styles.meta} parts={describeRow(row, props)} />
        </View>
        {row.kind === 'doc' ? <FavoriteToggleButton id={row.document.artifactId} isFavorite={row.document.favorite}
            addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
            onToggle={props.onToggleFavorite} testID={`prompt-picker-favorite:${row.id}`} />
            // Starring something you sent turns it into a favourite prompt where it stands (lab R1s).
            : row.kind === 'history' ? <FavoriteToggleButton id={row.id} isFavorite={false}
                addLabel={t('agentInput.promptPicker.saveAsFavorite')} removeLabel={t('agentInput.promptPicker.saveAsFavorite')}
                onToggle={props.onToggleFavorite} testID={`prompt-picker-favorite:${row.id}`} /> : null}
    </View>;
}

/** The full text of the highlighted row, with what ↵ will do and where it came from. */
export function PromptPickerPreview(props: RowLabels & Readonly<{ row: PromptPickerRow; read: (row: PromptPickerRow) => Promise<string> }>) {
    const contentRevision = props.row.kind === 'doc' ? props.row.document.updatedAtMs
        : props.row.kind === 'builtIn' ? props.row.prompt.body : props.row.entry.text;
    const contentId = props.row.id;
    const latestRow = React.useRef(props.row);
    latestRow.current = props.row;
    const [preview, setPreview] = React.useState<Readonly<{ id: string; revision: typeof contentRevision; text?: string; error?: true }> | null>(null);
    React.useEffect(() => {
        let active = true;
        void props.read(latestRow.current).then((text) => { if (active) setPreview({ id: contentId, revision: contentRevision, text }); },
            () => { if (active) setPreview({ id: contentId, revision: contentRevision, error: true }); });
        return () => { active = false; };
    }, [contentId, contentRevision, props.read]);
    const current = preview?.id === contentId && preview.revision === contentRevision ? preview : null;
    const { row } = props;
    const kind = row.kind === 'history' ? t('agentInput.promptPicker.previewSent') : t('agentInput.promptPicker.previewInserts');
    const origin = row.kind === 'doc' ? t('agentInput.promptPicker.previewEdited', { time: formatRelativeTimeShort(row.document.updatedAtMs, props.nowMs) })
        : row.kind === 'history' ? props.sessionNames.get(row.entry.sessionId) || null : null;
    return <View style={styles.preview} testID="prompt-picker-preview">
        <MetaLine style={styles.previewMeta} parts={describeRow(row, props)} trailing={kind} lines={2} />
        <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewScrollContent}>
            {current?.error ? <Text style={styles.previewError}>{t('agentInput.promptPicker.readError')}</Text>
                : current?.text !== undefined ? <PreviewText text={current.text} markdown={row.kind !== 'history'} />
                : <SkeletonRows rows={1} {...SELECTION_LIST_SKELETON_ROW_SHAPE} />}
        </ScrollView>
        {origin ? <Text style={styles.previewMeta} numberOfLines={1}>{origin}</Text> : null}
    </View>;
}

/**
 * The prompt as the reader should see it: a leading YAML front matter block (a skill's `name`,
 * `description`, `metadata`) is machine header, not prompt text, so the preview starts at the body.
 */
export function promptPreviewDisplayText(text: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    return readableMessageText(match ? text.slice(match[0].length).replace(/^\s+/, '') : text);
}

/**
 * `$ARGUMENTS` is where the caret lands after insert, so the preview marks it as code. A saved prompt
 * is markdown: it renders through the same renderer as every other document; what you sent stays the
 * plain text it was.
 */
function markArguments(markdown: string): string {
    return markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part.split(ARGUMENTS_TOKEN).join(`\`${ARGUMENTS_TOKEN}\``)).join('');
}

function PreviewText(props: Readonly<{ text: string; markdown: boolean }>) {
    const text = promptPreviewDisplayText(props.text);
    if (props.markdown) return <MarkdownView profile="widget" markdown={markArguments(text)} />;
    return <Text selectable style={styles.previewText}>{text}</Text>;
}

/** One quiet line in the list: an invitation, an empty result or a recoverable failure. */
export function PromptPickerNotice(props: Readonly<{
    text: string;
    title?: string;
    tone?: 'default' | 'error';
    action?: Readonly<{ label: string; onPress: () => void }>;
    testID?: string;
}>) {
    return <View style={styles.notice} testID={props.testID}>
        {props.title ? <Text style={styles.noticeTitle}>{props.title}</Text> : null}
        <View style={styles.actionLine}>
            <Text style={[styles.noticeText, props.tone === 'error' ? styles.noticeError : null]} accessibilityLiveRegion="polite">{props.text}</Text>
            {props.action ? <View style={styles.action}>
                <Text style={styles.noticeText}>{' · '}</Text>
                <TextLinkButton label={props.action.label} onPress={props.action.onPress}
                    tone={props.tone === 'error' ? 'strong' : 'quiet'} testID={props.testID ? `${props.testID}:action` : undefined} />
            </View> : null}
        </View>
    </View>;
}

export function PromptPickerSkeletonRow(props: Readonly<{ testID?: string }>) {
    return <View style={styles.skeleton} testID={props.testID}>
        <SkeletonRows rows={3} {...SELECTION_LIST_SKELETON_ROW_SHAPE} />
    </View>;
}

/** The move from Sent before into Favourites: the row rises into its new group (lab R1s, 200 ms; reduced motion fades). */
const SAVE_ROW_MOTION = resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' });

/**
 * A Sent before row becoming a favourite prompt in place (lab R1s): its first line as a focused name
 * field, Save, and the star that decides whether it lands in Favourites. It saves through the one
 * "message becomes a prompt" owner the message row uses; Escape or Cancel puts it back.
 */
export function PromptPickerSaveRow(props: Readonly<{
    row: Extract<PromptPickerRow, { kind: 'history' }>;
    serverId: string;
    nowMs: number;
    onSaved: (saved: SaveMessageAsPromptSaved) => void;
    onCancel: () => void;
}>) {
    const { theme } = useUnistyles();
    const form = useSaveMessageAsPrompt({ text: props.row.entry.text, serverId: props.serverId, onSaved: props.onSaved });
    const motion = useOverlayMotionAnimation({ visible: true, preset: SAVE_ROW_MOTION });
    const time = formatRelativeTimeShort(props.row.entry.createdAtMs, props.nowMs);
    const submit = form.canSave ? () => { void form.save(); } : undefined;
    return <Animated.View style={[styles.row, styles.saveRow, motion.style]} testID={`prompt-picker-save:${props.row.id}`}>
        <View style={[styles.lead, styles.saveLead]}>
            <Icon name="chat" size={16} color={theme.colors.text.secondary} />
        </View>
        <View style={styles.body}>
            <View style={styles.saveLine}>
                <FieldTextInput testID="prompt-picker-save-name" accessibilityLabel={t('committedMessageActions.name')}
                    value={form.title} onChangeText={form.setTitle} autoFocus selectTextOnFocus returnKeyType="done"
                    onSubmitEditing={submit} style={styles.saveField}
                    onKeyPress={(event) => {
                        if (!isEscapeKeyEvent(event)) return;
                        event.preventDefault?.();
                        (event as unknown as { stopPropagation?: () => void }).stopPropagation?.();
                        props.onCancel();
                    }} />
                <RoundButton testID="prompt-picker-save-confirm" size="small" title={t('common.save')}
                    disabled={!form.canSave} loading={form.isSaving} action={form.save} />
            </View>
            <View style={[styles.actionLine, styles.saveMeta]}>
                <Text style={[styles.meta, form.error ? styles.noticeError : null]} accessibilityLiveRegion="polite">
                    {form.error ?? t(form.favorite ? 'agentInput.promptPicker.saveInPlaceStarred' : 'agentInput.promptPicker.saveInPlace', { time })}
                </Text>
                <View style={styles.action}><Text style={styles.meta}>{' · '}</Text>
                    <TextLinkButton label={t('common.cancel')} onPress={props.onCancel} testID="prompt-picker-save-cancel" />
                </View>
            </View>
        </View>
        <View style={styles.saveStar}>
            <FavoriteToggleButton id={props.row.id} isFavorite={form.favorite} testID="prompt-picker-save-favorite"
                addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
                onToggle={() => form.setFavorite((value) => !value)} />
        </View>
    </Animated.View>;
}

/**
 * Hints for the keys the field owns (hardware keyboards only), then the honest state of the
 * history search: older pages are searched on demand, with progress and Stop.
 */
export function PromptPickerFooter(props: Readonly<{
    history: UserMessageHistoryEntriesSnapshot;
    hardwareKeyboard: boolean;
    /** The two-pane picker; the phone-width one is a touch-first list and leaves key hints out. */
    wide?: boolean;
    canSend: boolean;
    applyError: boolean;
    /** The library is still arriving while other rows (built-ins, history) already show. */
    libraryLoading?: boolean;
}>) {
    const { history } = props;
    const platform = resolveKeyboardPlatform();
    const pickerShortcut = useKeyboardShortcutLabel('composer.prompts.open');
    const status = props.applyError ? <Text style={[styles.status, styles.noticeError]} accessibilityLiveRegion="polite">{t('agentInput.promptPicker.applyError')}</Text>
        : history.error ? <View style={styles.actionLine}>
            <Text style={[styles.status, styles.noticeError]} accessibilityLiveRegion="polite">{t('agentInput.promptPicker.historyError')}</Text>
            <View style={styles.action}><Text style={styles.status}>{' · '}</Text>
                <TextLinkButton label={t('common.retry')} onPress={history.retry} tone="strong" />
            </View>
        </View>
        : history.isLoading ? <View style={styles.actionLine}>
            <Text style={styles.status} accessibilityLiveRegion="polite">
                {t('agentInput.promptPicker.searchingOlder', { searched: history.progress.sessionsSearched, total: history.progress.totalSessions })}
            </Text>
            <View style={styles.action}><Text style={styles.status}>{' · '}</Text>
                <TextLinkButton label={t('agentInput.promptPicker.stop')} onPress={history.stop} testID="prompt-picker-history-stop" />
            </View>
        </View>
        : history.hasMore ? <TextLinkButton label={t('agentInput.promptPicker.loadOlder')}
            onPress={() => { void history.loadMore(); }} testID="prompt-picker-history-more" />
        : null;
    const coverage = props.libraryLoading ? t('agentInput.promptPicker.loadingLibrary')
        : history.coverage === 'partial' ? t('agentInput.promptPicker.partialHistory')
        : history.coverage === 'loaded' ? t('agentInput.promptPicker.loadedHistory') : null;
    const hints = props.hardwareKeyboard && props.wide !== false;
    if (!hints && !status && !coverage) return null;
    return <View style={styles.footer} testID="prompt-picker-footer">
        {hints ? <View style={styles.hints}>
            <Hint keys="↑↓" label={t('commandPalette.hints.move')} />
            <Hint keys="↵" label={t('agentInput.promptPicker.insert')} />
            {props.canSend ? <Hint keys={formatKeybindingLabel({ binding: 'Mod+Enter' }, platform)} label={t('agentInput.promptPicker.send')} /> : null}
            <Hint keys={formatKeybindingLabel({ binding: 'Mod+D' }, platform)} label={t('agentInput.promptPicker.favorite')} />
        </View> : null}
        <View style={[styles.footerEnd, hints ? null : styles.footerStart]}>
            {/* One status line: the coverage fact, then its next step after a quiet separator. */}
            {coverage ? <Text style={styles.status} accessibilityLiveRegion="polite" testID="prompt-picker-history-coverage">{coverage}{status ? ' ·' : ''}</Text> : null}
            {status ?? (!coverage && hints && pickerShortcut ? <Hint keys={pickerShortcut} label={t('agentInput.promptPicker.title')} /> : null)}
        </View>
    </View>;
}

function Hint(props: Readonly<{ keys: string; label: string }>) {
    return <View style={styles.hint}><KeyHint label={props.keys} /><Text style={styles.hintLabel}>{props.label}</Text></View>;
}

const styles = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, paddingLeft: 14, paddingRight: theme.space.s10, paddingVertical: theme.space.s6, minHeight: 48 },
    lead: { width: 20, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 1 },
    title: { ...Typography.variant('label', 'semiBold'), ...Typography.default(), color: theme.colors.text.primary },
    meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    token: Typography.mono(),
    metaRow: { flexDirection: 'row', alignItems: 'baseline', minWidth: 0 },
    metaLead: { flexShrink: 1, minWidth: 0 },
    // The in-place save row: the field and Save share one line; the meta says where it goes.
    saveRow: { alignItems: 'flex-start', paddingVertical: theme.space.s10 },
    saveLead: { marginTop: theme.space.s8 },
    saveLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    saveField: { flex: 1, minWidth: 0 },
    saveMeta: { marginTop: theme.space.s6 },
    saveStar: { marginTop: theme.space.s6 },
    preview: { width: 300, flexShrink: 0, minHeight: 0, gap: theme.space.s8, paddingHorizontal: 14, paddingVertical: theme.space.s12,
        borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
    previewMeta: { ...({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }), color: theme.colors.text.tertiary },
    previewScroll: { flex: 1, minHeight: 0 },
    previewScrollContent: { paddingBottom: theme.space.s4 },
    previewText: { ...Typography.default(), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.text.primary },
    previewError: { ...Typography.default(), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.state.danger.foreground },
    notice: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s10, paddingBottom: theme.space.s8, gap: theme.space.s6 },
    noticeTitle: { ...Typography.variant('meta'), ...Typography.default('semiBold'), color: theme.colors.text.secondary },
    noticeText: { ...Typography.default(), ...ITEM_SUBTITLE_TEXT_METRICS.cozy, color: theme.colors.text.secondary },
    noticeError: { color: theme.colors.state.danger.foreground },
    actionLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
    action: { flexDirection: 'row', alignItems: 'center' },
    skeleton: { paddingHorizontal: theme.space.s4 },
    footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: theme.space.s4, minHeight: 34,
        paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    hints: { maxWidth: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: theme.space.s4 },
    footerEnd: { maxWidth: '100%', flexGrow: 1, flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s6, justifyContent: 'flex-end', alignItems: 'center' },
    footerStart: { justifyContent: 'flex-start' },
    hint: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    hintLabel: { ...({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }), color: theme.colors.text.tertiary },
    status: { ...({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }), color: theme.colors.text.secondary, textAlign: 'right' },
}));
