import * as React from 'react';
import * as ExpoRouter from 'expo-router';
import type { useRouter } from 'expo-router';
import { NavigationContext } from '@react-navigation/native';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';

export type DestinationNavigation = Pick<ReturnType<typeof useRouter>, 'push' | 'replace' | 'back'>
    & Partial<ReturnType<typeof useRouter>> & {
        /** Automatic route selection, distinct from an explicit replacement chosen by the user. */
        redirect?: ReturnType<typeof useRouter>['replace'];
        /** Open another destination without retiring the caller's mounted draft. */
        pushRetainingCurrent?: ReturnType<typeof useRouter>['push'];
        /** Retain this pane before acquiring work that outlives its preview. */
        retainCurrent?: () => void;
    };

export type DestinationInstanceContextValue = Readonly<{
    tabId: string;
    ref: DestinationRef;
    pathname: string;
    focused: boolean;
    visible: boolean;
    navigation?: DestinationNavigation;
}>;

// Identity consumers share the host's context without loading destination composition.
export const DestinationInstanceContext = React.createContext<DestinationInstanceContextValue | null>(null);
export const DestinationHeaderOptionsContext = React.createContext<((options: NativeStackNavigationOptions) => void) | null>(null);

export function useDestinationInstanceKey(): string | null {
    return React.useContext(DestinationInstanceContext)?.tabId ?? null;
}

/** The retained host owns its chrome options; Back still belongs to the same tab owner. */
export function useDestinationNavigation() {
    const instance = React.useContext(DestinationInstanceContext);
    const nativeNavigation = React.useContext(NavigationContext);
    const setOptions = React.useContext(DestinationHeaderOptionsContext);
    return React.useMemo(() => instance ? {
        canGoBack: () => instance.navigation?.canGoBack?.() ?? false,
        goBack: () => instance.navigation?.back(),
        setOptions: setOptions ?? ((_options: NativeStackNavigationOptions) => {}),
        isFocused: () => instance.focused,
        addListener: (_event: string, _listener: () => void) => () => {},
        getParent: () => undefined,
    } : nativeNavigation, [instance, nativeNavigation, setOptions]);
}

/** Hosted destinations publish to retained chrome; native destinations keep their stack navigator. */
export function useDestinationRouteNavigation() {
    const hosted = useDestinationInstanceKey() !== null;
    const navigation = useDestinationNavigation();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership stays fixed for a mounted body.
    if (!hosted) return ExpoRouter.useNavigation();
    if (!navigation) throw new Error('A hosted destination requires navigation');
    return navigation;
}

/** Whether this mounted body is the focused one: its workspace pane's, or its Stack screen's. */
export function useDestinationFocus(): boolean {
    const instance = React.useContext(DestinationInstanceContext);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return instance ? instance.focused : useOptionalScreenIsFocused();
}
