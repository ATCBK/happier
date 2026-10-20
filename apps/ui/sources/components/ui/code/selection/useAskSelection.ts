import * as React from 'react';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { askAboutRanges, type AskSelectionSessionTarget } from './askAboutRanges';
import { askSelectionContext } from './askSelectionContext';
import { buildAskSelectionQuote, type AskSelectionRange, type FilesAskWithoutSessionTarget } from './askSelectionModel';
import { askSelectionQuote, type AskSelectionTargetContext } from './askSelectionTarget';

export { askAboutRanges } from './askAboutRanges';
export type { AskSelectionTargetContext } from './askSelectionTarget';

export type AskSelection = AskSelectionRange & Readonly<{ text: string; rect?: Rect | null }>;
export type AskSelectionSource = 'file' | 'diff' | 'markdown' | 'terminal' | 'transcript';

export type UseAskSelectionInput = Readonly<{
    scopeId: string;
    workspaceScope: WorkspaceScopeBase;
    filePath?: string;
    source: AskSelectionSource;
    getSelection: () => AskSelection | null;
    subscribeSelection?: (listener: () => void) => () => void;
    /** Full source text; diff surfaces also provide their canonical CodeLine table. */
    getLinesText?: () => string;
    lines?: readonly CodeLine[];
    savedText?: string;
    sessionTarget: AskSelectionSessionTarget | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    withoutSessionTarget?: FilesAskWithoutSessionTarget;
    openDetailsTab: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    onComment?: (drafts: readonly ReviewCommentDraft[]) => void;
    onDetachedUnavailable?: (reason: string) => void;
    active?: boolean;
}>;

/** One Ask operation behind toolbars, phone actions, menus and the selection keyboard command. */
export function useAskSelection(input: UseAskSelectionInput) {
    const router = useRouter();
    const sourceId = React.useId();
    const ownerKey = JSON.stringify([input.scopeId, buildWorkspaceCacheKey(input.workspaceScope), input.filePath ?? null, input.source]);
    const [selectionState, setSelectionState] = React.useState(() => ({ ownerKey, selection: input.getSelection() }));
    const selection = selectionState.ownerKey === ownerKey ? selectionState.selection : null;
    const [unavailableReason, setUnavailableReason] = React.useState<string | null>(null);
    const rememberedSelection = React.useRef({ ownerKey, selection });
    const latest = React.useRef(input);
    const latestOwnerKey = React.useRef(ownerKey);
    latest.current = input;
    latestOwnerKey.current = ownerKey;
    const remember = React.useCallback(() => {
        if (latestOwnerKey.current !== ownerKey) return;
        const next = latest.current.getSelection();
        setSelectionState((previous) => previous.ownerKey === ownerKey && previous.selection === next
            ? previous : { ownerKey, selection: next });
        if (next) {
            rememberedSelection.current = { ownerKey, selection: next };
            if (latest.current.active !== false) askSelectionContext.remember(input.scopeId, sourceId);
        }
    }, [ownerKey, input.scopeId, sourceId]);
    React.useEffect(() => {
        if (rememberedSelection.current.ownerKey !== ownerKey) rememberedSelection.current = { ownerKey, selection: null };
        setUnavailableReason(null);
        remember();
        const unsubscribe = input.subscribeSelection?.(remember);
        return () => { unsubscribe?.(); askSelectionContext.forget(input.scopeId, sourceId); };
    }, [ownerKey, input.scopeId, input.subscribeSelection, remember, sourceId]);
    const readSelection = React.useCallback(() => latest.current.getSelection()
        ?? (rememberedSelection.current.ownerKey === latestOwnerKey.current ? rememberedSelection.current.selection : null), []);
    const lastSource = React.useSyncExternalStore(askSelectionContext.subscribe,
        () => askSelectionContext.read(input.scopeId), () => null);

    const getTargetContext = React.useCallback((): AskSelectionTargetContext => {
        const params = latest.current;
        const lifetime = params.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : params.accountLifetime;
        return { accountLifetime: lifetime, withoutSessionTarget: params.withoutSessionTarget,
            openDetailsTab: params.openDetailsTab, onDetachedUnavailable: (reason) => {
                setUnavailableReason(reason);
                params.onDetachedUnavailable?.(reason);
            },
            navigateToNewSession: ({ draftId, ...route }) => {
                if (!lifetime?.isCurrent()) return;
                router.push({ pathname: '/new', params: {
                    draftId, draftServerId: lifetime.scope.serverId, draftAccountId: lifetime.scope.accountId,
                    ...Object.fromEntries(Object.entries(route).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                } });
            } };
    }, [router]);

    const ask = React.useCallback(async (options?: Readonly<{ sideRun?: boolean }>): Promise<boolean> => {
        const params = latest.current;
        setUnavailableReason(null);
        const selected = readSelection();
        if (!selected) return false;
        const text = selected.text || (params.getLinesText?.() ?? params.savedText ?? '').split('\n').slice(selected.startLine - 1, selected.endLine).join('\n');
        const anchored = (params.source === 'file' || params.source === 'diff') && !!params.filePath;
        if (anchored) {
            const result = await askAboutRanges({ workspaceScope: params.workspaceScope, filePath: params.filePath!,
                ranges: [selected], savedText: params.savedText ?? params.getLinesText?.() ?? '',
                text: params.getLinesText?.(), source: params.source === 'diff' ? 'diff' : 'file', lines: params.lines,
                sessionTarget: params.sessionTarget, targetContext: getTargetContext(), sideRun: options?.sideRun });
            return result.created > 0;
        }
        const quote = buildAskSelectionQuote({ text, filePath: params.filePath,
            ...(params.filePath ? { startLine: selected.startLine, endLine: selected.endLine } : {}) });
        return askSelectionQuote({ workspaceScope: params.workspaceScope, sessionTarget: params.sessionTarget,
            quote, context: getTargetContext(), sideRun: options?.sideRun });
    }, [getTargetContext, readSelection]);

    const comment = React.useCallback(async () => {
        const params = latest.current;
        const selected = readSelection();
        if (!selected || !params.filePath || (params.source !== 'file' && params.source !== 'diff')) return false;
        const result = await askAboutRanges({ workspaceScope: params.workspaceScope, filePath: params.filePath,
            ranges: [selected], savedText: params.savedText ?? params.getLinesText?.() ?? '', text: params.getLinesText?.(),
            source: params.source, lines: params.lines, sessionTarget: null, includeInPrompt: false });
        params.onComment?.(result.drafts);
        return result.created > 0;
    }, [readSelection]);
    const copy = React.useCallback(() => {
        const params = latest.current;
        const selected = readSelection();
        if (!selected) return Promise.resolve(false);
        return setClipboardStringSafe(selected.text || (params.getLinesText?.() ?? params.savedText ?? '').split('\n').slice(selected.startLine - 1, selected.endLine).join('\n'));
    }, [readSelection]);
    useKeyboardShortcutHandlers(input.active !== false && (selection || (rememberedSelection.current.ownerKey === ownerKey && rememberedSelection.current.selection)) && lastSource === sourceId
        ? { 'editor.selection.ask': () => { void ask(); return 'handled'; } } : {});
    const menuItems = React.useMemo(() => input.sessionTarget ? [{ id: 'ask-in-side-run' as const,
        label: t('files.askSelection.sideRun'), run: () => ask({ sideRun: true }) }] : [], [ask, input.sessionTarget]);
    return { selection, ask, comment, copy, menuItems, remember, getTargetContext, unavailableReason,
        canComment: !!input.filePath && (input.source === 'file' || input.source === 'diff') };
}
