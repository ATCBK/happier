import * as React from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

function createWrapStore() {
    return createStore<ReadonlySet<string>>(() => new Set());
}

const WrapStoreContext = React.createContext<ReturnType<typeof createWrapStore> | null>(null);
const WrapKeyContext = React.createContext<string | null>(null);

export const MarkdownCodeBlockWrapKeyProvider = WrapKeyContext.Provider;

export function MarkdownCodeBlockWrapStateProvider({ children }: Readonly<{ children: React.ReactNode }>) {
    // The transcript owns the lifetime so recycling an individual row does not erase its choices.
    const [store] = React.useState(createWrapStore);
    return <WrapStoreContext.Provider value={store}>{children}</WrapStoreContext.Provider>;
}

export function useMarkdownCodeBlockWrap(): readonly [boolean, (wrapped: boolean) => void] {
    const retainedStore = React.useContext(WrapStoreContext);
    const key = React.useContext(WrapKeyContext);
    // Standalone Markdown also supports wrapping, without sharing anonymous blocks' state.
    const [localStore] = React.useState(() => key && retainedStore ? retainedStore : createWrapStore());
    const store = key && retainedStore ? retainedStore : localStore;
    const blockKey = key ?? '';
    const wrapped = useStore(store, state => state.has(blockKey));
    const notifyLayoutMutation = useTranscriptRowLayoutMutation();
    const setWrapped = React.useCallback((next: boolean) => {
        if (store.getState().has(blockKey) === next) return;
        notifyLayoutMutation({ reason: next ? 'expand' : 'collapse', sourceId: blockKey });
        store.setState((previous) => {
            const updated = new Set(previous);
            if (next) updated.add(blockKey);
            else updated.delete(blockKey);
            return updated;
        }, true);
    }, [blockKey, notifyLayoutMutation, store]);
    return [wrapped, setWrapped];
}
