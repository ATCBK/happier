import * as React from 'react';
import { Platform } from 'react-native';

import { RouteModalPortalScope } from '@/components/navigation/RouteModalPortalScope';
import { useSetting } from '@/sync/domains/state/storage';
import type { NewSessionPresentationModeV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import {
    resolveNewSessionPickerRoutePresentation,
    resolveNewSessionSecretRequirementRoutePresentation,
} from '@/components/sessions/new/navigation/newSessionPresentation';

export function createNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
    presentationMode?: NewSessionPresentationModeV1 | null;
    platformOs?: string;
}>) {
    return {
        headerShown: params.headerShown ?? true,
        title: params.title,
        headerTitle: params.title,
        headerBackTitle: params.headerBackTitle,
        presentation: resolveNewSessionPickerRoutePresentation({
            mode: params.presentationMode,
            platformOs: params.platformOs ?? Platform.OS,
        }),
    } as const;
}

export function useNewSessionPickerRoutePresentation() {
    const presentationMode = useSetting('newSessionPresentationModeV1');
    return React.useMemo(() => resolveNewSessionPickerRoutePresentation({
        mode: presentationMode,
        platformOs: Platform.OS,
    }), [presentationMode]);
}

export function useNewSessionSecretRequirementRoutePresentation() {
    const presentationMode = useSetting('newSessionPresentationModeV1');
    return React.useMemo(() => resolveNewSessionSecretRequirementRoutePresentation({
        mode: presentationMode,
        platformOs: Platform.OS,
    }), [presentationMode]);
}

export function useNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
}>) {
    const presentationMode = useSetting('newSessionPresentationModeV1');
    return React.useMemo(() => createNewSessionContainedModalScreenOptions({
        ...params,
        presentationMode,
    }), [params.headerBackTitle, params.headerShown, params.title, presentationMode]);
}

/**
 * Actual `/new` routes use the canonical route portal owner. An embedded
 * composer is not another route: it inherits its page's host so withdrawing
 * the composer cannot also destroy unrelated page dialogs.
 */
export function NewSessionScreenPortalScope(props: Readonly<{
    presentation?: 'screen' | 'embedded';
    children: React.ReactNode;
}>) {
    return props.presentation === 'embedded'
        ? <>{props.children}</>
        : <RouteModalPortalScope>{props.children}</RouteModalPortalScope>;
}
