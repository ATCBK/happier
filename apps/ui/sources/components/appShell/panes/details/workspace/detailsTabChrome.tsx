import * as React from 'react';
import { readWorkspaceFileEditorDraft } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft';
import { getOwnDetailsWorkspaceRecordEntry, type PaneDetailsStateView } from './detailsWorkspaceTypes';

/** Persisted drafts exist only while dirty, including editors whose tab body is not mounted. */
export function unsavedWorkspaceFilePaths(scope: Readonly<{
    accountId: string | null;
    details: (Pick<PaneDetailsStateView, 'tabs' | 'tabState'> & Partial<Pick<PaneDetailsStateView, 'groups'>>) | null | undefined;
}>): readonly string[] {
    if (!scope.details) return [];
    const paths = new Set<string>();
    const tabs = [...scope.details.tabs, ...(scope.details.groups?.flatMap((group) => group.tabs) ?? [])];
    for (const tab of tabs) {
        if (tab.kind !== 'file') continue;
        const draft = readWorkspaceFileEditorDraft(getOwnDetailsWorkspaceRecordEntry(scope.details.tabState, tab.key), scope.accountId);
        if (!draft?.isEditingFile || !tab.resource || typeof tab.resource !== 'object') continue;
        const path = (tab.resource as Readonly<{ path?: unknown }>).path;
        if (typeof path === 'string' && path) paths.add(path);
    }
    return [...paths];
}

/**
 * What a tab's content tells the strip about itself: today only that it holds unsaved edits (a
 * file being edited). The content is the only owner of that fact; the strip draws it.
 */
export type DetailsTabChromeApi = Readonly<{
    setUnsaved: (unsaved: boolean) => void;
}>;

const NOOP_CHROME: DetailsTabChromeApi = { setUnsaved: () => {} };

const DetailsTabChromeContext = React.createContext<DetailsTabChromeApi>(NOOP_CHROME);

export function DetailsTabChromeProvider(props: Readonly<{ value: DetailsTabChromeApi; children: React.ReactNode }>) {
    return <DetailsTabChromeContext.Provider value={props.value}>{props.children}</DetailsTabChromeContext.Provider>;
}

/** Outside a Details tab (a full-screen file route) the report goes nowhere. */
export function useDetailsTabChrome(): DetailsTabChromeApi {
    return React.useContext(DetailsTabChromeContext);
}

/**
 * The group's record of unsaved tabs. It changes only when a tab's fact flips, so the strip
 * re-renders on an edit's first keystroke and on save, never per keystroke.
 */
export function useDetailsTabUnsavedKeys(pinTab: (tabKey: string) => void): Readonly<{
    unsavedKeys: ReadonlySet<string>;
    chromeFor: (tabKey: string) => DetailsTabChromeApi;
}> {
    const [unsavedKeys, setUnsavedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const pinTabRef = React.useRef(pinTab);
    pinTabRef.current = pinTab;
    const chromeByKeyRef = React.useRef(new Map<string, DetailsTabChromeApi>());
    const chromeFor = React.useCallback((tabKey: string): DetailsTabChromeApi => {
        const existing = chromeByKeyRef.current.get(tabKey);
        if (existing) return existing;
        let reportedUnsaved = false;
        const chrome: DetailsTabChromeApi = {
            setUnsaved: (unsaved) => {
                if (reportedUnsaved === unsaved) return;
                reportedUnsaved = unsaved;
                if (unsaved) pinTabRef.current(tabKey);
                setUnsavedKeys((current) => {
                    if (current.has(tabKey) === unsaved) return current;
                    const next = new Set(current);
                    if (unsaved) next.add(tabKey);
                    else next.delete(tabKey);
                    return next;
                });
            },
        };
        chromeByKeyRef.current.set(tabKey, chrome);
        return chrome;
    }, []);
    return { unsavedKeys, chromeFor };
}
