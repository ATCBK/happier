// Vitest/node stub for `expo-router`.
// The real package imports React Native internals (`react-native/Libraries/...`) in its native entrypoints.

import { createExpoRouterMock } from './testkit/mocks/router';

// Early imports and suite-specific router mocks share the canonical boundary.
const { module: routerModule } = createExpoRouterMock();

export const Redirect = routerModule.Redirect;
export const Link = routerModule.Link;
export const Stack = routerModule.Stack;
export const useRouter = routerModule.useRouter;
export const useNavigation = routerModule.useNavigation;
export const useSegments = routerModule.useSegments;
export const usePathname = routerModule.usePathname;

export function useLocalSearchParams<
    TParams extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>,
>(): TParams {
    return routerModule.useLocalSearchParams() as TParams;
}

export function useGlobalSearchParams<
    TParams extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>,
>(): TParams {
    return routerModule.useGlobalSearchParams() as TParams;
}

export const router = routerModule.router;
