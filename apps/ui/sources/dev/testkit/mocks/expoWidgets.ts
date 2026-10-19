type ExpoWidgetsModule = typeof import('expo-widgets');

type ExpoWidgetsModuleMockOptions = Readonly<{
    importOriginal: () => Promise<ExpoWidgetsModule>;
    /** External widget handles; each fixture replaces only unavailable native methods. */
    widgets?: Readonly<Record<string, object>>;
    liveActivities?: Readonly<Record<string, object>>;
    addUserInteractionListener?: ExpoWidgetsModule['addUserInteractionListener'];
}>;

/** Preserve SDK factories and layouts, replacing only the selected native handle methods. */
export async function createExpoWidgetsModuleMock(options: ExpoWidgetsModuleMockOptions) {
    const actual = await options.importOriginal();
    return {
        ...actual,
        createWidget: <Props extends object>(...args: Parameters<typeof actual.createWidget<Props>>) => (
            Object.assign(actual.createWidget<Props>(...args), options.widgets?.[args[0]])
        ),
        createLiveActivity: <Props extends object>(...args: Parameters<typeof actual.createLiveActivity<Props>>) => (
            Object.assign(actual.createLiveActivity<Props>(...args), options.liveActivities?.[args[0]])
        ),
        ...(options.addUserInteractionListener
            ? { addUserInteractionListener: options.addUserInteractionListener }
            : {}),
    };
}
