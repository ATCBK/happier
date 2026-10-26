import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';
import { collectionRequestRefKey, type CollectionRequestRef } from './collectionRequestRef';

/** Row-local disclosure only; the page's current-context owner captures Home/Account and retires commands. */
export function useCollectionRequestPeek(request: CollectionRequestRef | null, presented = true,
    description?: string) {
    const key = request ? collectionRequestRefKey(request) : null;
    const [opened, setOpened] = React.useState<string | null>(null);
    const open = presented && key !== null && opened === key;
    const commands = useCurrentUiContextLocalCommands(React.useMemo(() => !presented || key === null ? [] : [{
        key: `request.open:${key}`, title: t('approvals.review'), ...(description ? { description } : {}),
        invoke: () => { setOpened(key); },
    }, ...(open ? [{
        key: `request.close:${key}`, title: t('common.close'),
        invoke: () => { setOpened(null); },
    }] : [])], [description, key, open, presented]));
    const show = React.useCallback(() => key === null ? Promise.resolve(false) : commands.invoke(`request.open:${key}`), [commands, key]);
    const dismiss = React.useCallback(() => key === null ? Promise.resolve(false) : commands.invoke(`request.close:${key}`), [commands, key]);
    const onRetire = React.useCallback(() => { setOpened(null); }, []);
    // Clearing on hidden/recycled anchors also prevents re-opening a retained disclosure on their return.
    React.useLayoutEffect(() => { setOpened(null); }, [key, presented]);
    return { open, show, dismiss, onRetire };
}
