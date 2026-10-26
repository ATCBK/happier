import * as React from 'react';
import type { ProjectPageCatalogModel } from './useProjectPageCatalog';
import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';

/** One presented Project's already-produced descriptors, scoped to this mounted app shell. */
type ProjectPageChromeModel = Pick<ProjectPageCatalogModel, 'pages' | 'activePageId' | 'target' | 'context' | 'projection' | 'authority'>;
type Publisher = Readonly<{
    publish: (model: ProjectPageChromeModel) => void;
    withdraw: (model: ProjectPageChromeModel) => void;
}>;
const ModelContext = React.createContext<ProjectPageChromeModel | null>(null);
const PublishContext = React.createContext<Publisher>({ publish: () => {}, withdraw: () => {} });

export function ProjectPageChromeProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [model, setModel] = React.useState<ProjectPageChromeModel | null>(null);
    const publish = React.useCallback<Publisher['publish']>(next => setModel(next), []);
    const withdraw = React.useCallback<Publisher['withdraw']>(previous => setModel(current => current === previous ? null : current), []);
    const publisher = React.useMemo(() => ({ publish, withdraw }), [publish, withdraw]);
    return <PublishContext.Provider value={publisher}><ModelContext.Provider value={model}>
        {props.children}
    </ModelContext.Provider></PublishContext.Provider>;
}

/** Destination visibility owns publication; the bridge performs no Source, catalog or body work. */
export function usePublishProjectPageChrome(model: ProjectPageChromeModel, presented: boolean): void {
    // A retained native screen has no destination visibility context. Only its
    // focused scene may publish the phone's one current Project bar.
    const focused = useDestinationFocus();
    const active = presented && focused;
    const publisher = React.useContext(PublishContext);
    const published = React.useRef<ProjectPageChromeModel | null>(null);
    React.useEffect(() => {
        if (!active) return;
        return () => {
            if (published.current) publisher.withdraw(published.current);
            published.current = null;
        };
    }, [active, publisher]);
    React.useEffect(() => {
        if (!active) return;
        published.current = model;
        publisher.publish(model);
    }, [model, active, publisher]);
}

export function useProjectPageChrome(): ProjectPageChromeModel | null {
    return React.useContext(ModelContext);
}
