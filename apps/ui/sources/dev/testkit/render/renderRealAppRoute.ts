import * as React from 'react';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { renderScreen } from './renderScreen';

/** Provider composition only: importing it registers no transport or screen module mocks. */
export async function createRealAppRouteElement(
    Screen: React.ComponentType,
    credentials: AuthCredentials | null,
    options: Readonly<{ contextWrapper?: React.ComponentType<React.PropsWithChildren> }> = {},
) {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { ModalProvider } = await import('@/modal/ModalProvider');
    const element = React.createElement(Screen);
    const content = options.contextWrapper ? React.createElement(options.contextWrapper, null, element) : element;
    return React.createElement(InjectedAuthProvider, { credentials, children:
        React.createElement(ModalProvider, { children: content }),
    });
}

export async function renderRealAppRoute(
    Screen: React.ComponentType,
    credentials: AuthCredentials | null,
    options: Parameters<typeof createRealAppRouteElement>[2] = {},
) {
    return renderScreen(await createRealAppRouteElement(Screen, credentials, options));
}
