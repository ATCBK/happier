export type NativeThemePreferenceTransitionControllerDependencies = {
    animateOverlay: () => Promise<void> | void;
    captureSurface: () => Promise<string | null> | string | null;
    hideOverlay: () => void;
    releaseSurface?: (uri: string) => void;
    showOverlay: (uri: string, direction?: 'sunrise' | 'night') => void;
    waitForFrame: () => Promise<void> | void;
    recordBreadcrumb?: (breadcrumb: NativeThemePreferenceTransitionBreadcrumb) => void;
};

export type NativeThemePreferenceTransitionBreadcrumb = Readonly<{
    phase: 'mutation-before-overlay' | 'overlay-shown';
}>;

export function createNativeThemePreferenceTransitionController(
    dependencies: NativeThemePreferenceTransitionControllerDependencies,
) {
    return {
        async run(mutation: () => void, direction?: 'sunrise' | 'night'): Promise<void> {
            const uri = await dependencies.captureSurface();
            if (!uri) {
                mutation();
                return;
            }
            try {
                dependencies.recordBreadcrumb?.({ phase: 'mutation-before-overlay' });
                mutation();
                dependencies.recordBreadcrumb?.({ phase: 'overlay-shown' });
                dependencies.showOverlay(uri, direction);
                await dependencies.waitForFrame();
                await dependencies.animateOverlay();
            } finally {
                dependencies.hideOverlay();
                dependencies.releaseSurface?.(uri);
            }
        },
    };
}
