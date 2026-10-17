import * as React from 'react';
import { createHappierCollectionDraftTitleStore, type HappierCollectionDraftTitleStore } from '@happier-dev/plugin-ui/presentation';

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
    return collection ?? standalone;
}
