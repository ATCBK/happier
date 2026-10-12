/** One demand edge for the SDK's guest bootstrap and host response codecs. */
export function loadPluginUiHostSupport(): Promise<typeof import('@happier-dev/plugin-sdk/host/ui')> {
    return import('@happier-dev/plugin-sdk/host/ui');
}
