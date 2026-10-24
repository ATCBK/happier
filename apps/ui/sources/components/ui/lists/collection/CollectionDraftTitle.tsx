import * as React from 'react';
import { createHappierCollectionDraftTitleStore, type HappierCollectionDraftTitleStore } from '@happier-dev/plugin-ui/presentation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

/** A mounted collection shares one draft title between its rail and editor. */
const CollectionDraftTitleContext = React.createContext<HappierCollectionDraftTitleStore | null>(null);

export function CollectionDraftTitleScope(props: React.PropsWithChildren): React.ReactElement {
    const [titles] = React.useState(() => createHappierCollectionDraftTitleStore());
    return <CollectionDraftTitleContext.Provider value={titles}>{props.children}</CollectionDraftTitleContext.Provider>;
}

export function useCollectionDraftTitle(): HappierCollectionDraftTitleStore {
    const collection = React.useContext(CollectionDraftTitleContext);
    // Standalone authoring (for example the composer Profile editor) has no rail.
    const [standalone] = React.useState(() => collection ?? createHappierCollectionDraftTitleStore());
    const titles = collection ?? standalone;
    const layoutPresented = useLayoutPresentationActive();
    const screenFocused = useOptionalScreenIsFocused();
    const presented = layoutPresented && screenFocused;
    const presentedRef = React.useRef(presented);
    presentedRef.current = presented;
    // A retained editor keeps its own latest intent, including callback-only publishers.
    // A reader never requests a title and must never replay the collection's global value.
    const requestedTitle = React.useRef<string | null>(null);
    const publish = React.useCallback((title: string) => {
        requestedTitle.current = title;
        // Read current presentation even from a cleanup captured before the editor was hidden.
        if (presentedRef.current) titles.publish(title);
    }, [titles]);
    React.useEffect(() => {
        if (presented && requestedTitle.current !== null) titles.publish(requestedTitle.current);
    }, [presented, titles]);
    return React.useMemo(() => ({ publish, useTitle: titles.useTitle }), [publish, titles]);
}
