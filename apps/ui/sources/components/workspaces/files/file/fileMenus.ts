import type { TranslationKeyNoParams } from '@/text';

export type FileMenuSurface = 'page' | 'phone' | 'treeRow';
export type FileMenuAvailability = 'hidden' | 'enabled' | Readonly<{ disabledReason: string }>;
type FileMenuRun = () => void | Promise<void>;

/** Behaviour is supplied by its owner; the File page owns this one shared item inventory. */
export type FileMenuContext = Readonly<{
    machineReachable: boolean;
    unavailableReason: string;
    hasCachedContent: boolean;
    platform: 'web' | 'tauri' | 'ios' | 'android';
    isDirectory?: boolean;
    partial?: boolean;
    blame?: boolean;
    readBlame?: boolean;
    open?: FileMenuRun;
    openBeside?: FileMenuRun;
    openWithBlame?: FileMenuRun;
    toggleWrap?: FileMenuRun;
    chooseBackground?: FileMenuRun;
    showInfo?: FileMenuRun;
    raw?: FileMenuRun;
    copyContents?: FileMenuRun;
    selectLines?: FileMenuRun;
    revealInFiles?: FileMenuRun;
    openChanges?: FileMenuRun;
    /** P4: leave editing and drop the unsaved draft (the editor's own owner decides what that means). */
    discardEdits?: FileMenuRun;
    toggleBlame?: FileMenuRun;
    commands?: Partial<Readonly<Record<'code.goToDefinition' | 'code.showInfo' | 'code.showProblems' | 'code.restart', FileMenuRun>>>;
    changes?: Readonly<{ discardAll?: FileMenuRun; restoreBeforeTurn?: FileMenuRun; restoreBeforeTurnTitle?: string }>;
    copyPath?: FileMenuRun;
    copyLink?: FileMenuRun;
    attachToMessage?: FileMenuRun;
    saveAsArtifact?: FileMenuRun;
    download?: FileMenuRun;
    shareFile?: FileMenuRun;
    rename?: FileMenuRun;
    openInDefaultApp?: FileMenuRun;
}>;

export type FileMenuItem = Readonly<{
    id: string;
    group: 'open' | 'view' | 'code' | 'share' | 'change';
    titleKey: TranslationKeyNoParams;
    title?: string;
    destructive?: boolean;
    surfaces: readonly FileMenuSurface[];
    state(context: FileMenuContext): FileMenuAvailability;
    run(context: FileMenuContext): void | Promise<void>;
}>;

const everySurface: readonly FileMenuSurface[] = ['page', 'phone', 'treeRow'];
const pageSurfaces: readonly FileMenuSurface[] = ['page', 'phone'];
type FileMenuCallback = (context: FileMenuContext) => FileMenuRun | undefined;

function item(input: Readonly<{
    id: string;
    group: FileMenuItem['group'];
    titleKey: TranslationKeyNoParams;
    callback: FileMenuCallback;
    surfaces?: readonly FileMenuSurface[];
    requiresMachine?: boolean;
    requiresContent?: boolean;
    destructive?: boolean;
    visible?: (context: FileMenuContext) => boolean;
}>): FileMenuItem {
    const availability = (context: FileMenuContext): FileMenuAvailability => {
        if (!input.callback(context) || input.visible?.(context) === false) return 'hidden';
        if (!context.machineReachable && (input.requiresMachine || (input.requiresContent && !context.hasCachedContent))) {
            return { disabledReason: context.unavailableReason };
        }
        return 'enabled';
    };
    return {
        id: input.id, group: input.group, titleKey: input.titleKey, destructive: input.destructive,
        surfaces: input.surfaces ?? everySurface,
        state: availability,
        run: context => {
            // The same admission is enforced for keyboard/menu consumers as for the rendered row.
            if (availability(context) === 'enabled') return input.callback(context)?.();
        },
    };
}

export const FILE_MENU_ITEMS: readonly FileMenuItem[] = [
    item({ id: 'open', group: 'open', titleKey: 'common.open', callback: c => c.open, surfaces: ['treeRow'] }),
    item({ id: 'openBeside', group: 'open', titleKey: 'files.pane.menu.openBeside', callback: c => c.openBeside, surfaces: ['treeRow'] }),
    item({ id: 'openWithBlame', group: 'open', titleKey: 'files.pane.menu.openWithBlame', callback: c => c.openWithBlame,
        surfaces: ['treeRow'], visible: c => c.readBlame === true && !c.isDirectory }),
    item({ id: 'wrap', group: 'view', titleKey: 'files.pane.menu.wrap', callback: c => c.toggleWrap, surfaces: pageSurfaces }),
    item({ id: 'background', group: 'view', titleKey: 'files.pane.menu.background', callback: c => c.chooseBackground, surfaces: pageSurfaces }),
    item({ id: 'info', group: 'view', titleKey: 'common.info', callback: c => c.showInfo, surfaces: pageSurfaces }),
    item({ id: 'raw', group: 'view', titleKey: 'files.pane.menu.raw', callback: c => c.raw, surfaces: pageSurfaces, requiresContent: true }),
    item({ id: 'copyContents', group: 'view', titleKey: 'files.pane.menu.copyContents', callback: c => c.copyContents, surfaces: pageSurfaces, requiresContent: true }),
    item({ id: 'selectLines', group: 'view', titleKey: 'files.fileActions.selectLines', callback: c => c.selectLines,
        surfaces: pageSurfaces, visible: c => !c.partial && !c.isDirectory }),
    item({ id: 'discardEdits', group: 'view', titleKey: 'files.pane.page.discardEdits', callback: c => c.discardEdits, surfaces: pageSurfaces }),
    item({ id: 'revealInFiles', group: 'view', titleKey: 'files.pane.menu.revealInFiles', callback: c => c.revealInFiles, surfaces: pageSurfaces }),
    item({ id: 'openChanges', group: 'view', titleKey: 'files.openChanges', callback: c => c.openChanges, surfaces: pageSurfaces }),
    item({ id: 'blame', group: 'code', titleKey: 'files.pane.menu.showBlame', callback: c => c.toggleBlame,
        surfaces: pageSurfaces, visible: c => c.readBlame === true && !c.isDirectory }),
    ...(['code.goToDefinition', 'code.showInfo', 'code.showProblems', 'code.restart'] as const).map(id => item({
        id, group: 'code', titleKey: id === 'code.goToDefinition' ? 'files.pane.menu.goToDefinition'
            : id === 'code.showInfo' ? 'files.pane.menu.showInfo'
                : id === 'code.showProblems' ? 'files.pane.intelligence.checkProblems' : 'files.pane.menu.restartLanguageServices',
        callback: c => c.commands?.[id], surfaces: pageSurfaces, requiresMachine: true,
    })),
    item({ id: 'copyPath', group: 'share', titleKey: 'files.pane.menu.copyPath', callback: c => c.copyPath }),
    item({ id: 'copyLink', group: 'share', titleKey: 'files.pane.menu.copyHappierLink', callback: c => c.copyLink }),
    item({ id: 'attachToMessage', group: 'share', titleKey: 'files.pane.menu.attachToMessage', callback: c => c.attachToMessage, requiresContent: true }),
    item({ id: 'saveAsArtifact', group: 'share', titleKey: 'files.pane.menu.saveAsArtifact', callback: c => c.saveAsArtifact, requiresMachine: true }),
    item({ id: 'download', group: 'share', titleKey: 'files.repositoryTree.actions.download', callback: c => c.download, requiresContent: true }),
    item({ id: 'shareFile', group: 'share', titleKey: 'common.share', callback: c => c.shareFile,
        visible: c => c.platform === 'android', requiresContent: true }),
    item({ id: 'rename', group: 'share', titleKey: 'common.rename', callback: c => c.rename, surfaces: ['treeRow'], requiresMachine: true }),
    item({ id: 'openInDefaultApp', group: 'share', titleKey: 'files.pane.menu.openInDefaultApp', callback: c => c.openInDefaultApp,
        visible: c => c.platform !== 'web', requiresMachine: true }),
    item({ id: 'restoreBeforeTurn', group: 'change', titleKey: 'files.pane.menu.restoreBeforeTurnFallback', callback: c => c.changes?.restoreBeforeTurn, requiresMachine: true }),
    item({ id: 'discard', group: 'change', titleKey: 'files.pane.menu.discardAllChanges', callback: c => c.changes?.discardAll, requiresMachine: true, destructive: true }),
];

export function resolveFileMenuItems(context: FileMenuContext, surface: FileMenuSurface) {
    return FILE_MENU_ITEMS.filter(item => item.surfaces.includes(surface)).flatMap(item => {
        const state = item.state(context);
        return state === 'hidden' ? [] : [{ ...item,
            titleKey: item.id === 'blame' && context.blame ? 'files.pane.menu.hideBlame' as const : item.titleKey,
            ...(item.id === 'restoreBeforeTurn' && context.changes?.restoreBeforeTurnTitle ? { title: context.changes.restoreBeforeTurnTitle } : {}),
            state, run: () => item.run(context) }];
    });
}

