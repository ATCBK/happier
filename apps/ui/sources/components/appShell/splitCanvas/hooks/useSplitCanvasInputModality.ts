import * as React from 'react';
import { Platform } from 'react-native';

export type SplitCanvasInputModality = 'pointer' | 'keyboard';

type InputModalitySource = Readonly<{
    read: () => SplitCanvasInputModality;
    subscribe: (listener: () => void) => () => void;
    change: (modality: SplitCanvasInputModality) => void;
}>;

const InputModalityContext = React.createContext<InputModalitySource | null>(null);
const readPointerModality = (): SplitCanvasInputModality => 'pointer';
const subscribeToNothing = () => () => {};

/** One event owner per canvas; only its focus-ring leaves subscribe to the fact. */
export function SplitCanvasInputModalityProvider(props: React.PropsWithChildren<Readonly<{ enabled: boolean }>>) {
    const [source] = React.useState<InputModalitySource>(() => {
        let modality: SplitCanvasInputModality = 'pointer';
        const listeners = new Set<() => void>();
        return {
            read: () => modality,
            subscribe(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            change(next) {
                if (modality === next) return;
                modality = next;
                for (const listener of listeners) listener();
            },
        };
    });

    React.useEffect(() => {
        if (!props.enabled || Platform.OS !== 'web') {
            return;
        }

        const maybeWindow: Window | undefined = (globalThis as { window?: Window }).window;
        if (!maybeWindow?.addEventListener) {
            return;
        }

        const onKeyDown = () => {
            source.change('keyboard');
        };

        const onPointerDown = () => {
            source.change('pointer');
        };

        maybeWindow.addEventListener('keydown', onKeyDown);
        maybeWindow.addEventListener('pointerdown', onPointerDown);
        maybeWindow.addEventListener('mousedown', onPointerDown);
        maybeWindow.addEventListener('touchstart', onPointerDown);

        return () => {
            maybeWindow.removeEventListener('keydown', onKeyDown);
            maybeWindow.removeEventListener('pointerdown', onPointerDown);
            maybeWindow.removeEventListener('mousedown', onPointerDown);
            maybeWindow.removeEventListener('touchstart', onPointerDown);
        };
    }, [props.enabled, source]);

    return React.createElement(InputModalityContext.Provider, { value: source }, props.children);
}

export function useSplitCanvasInputModality(presented: boolean): SplitCanvasInputModality {
    const source = React.useContext(InputModalityContext);
    return React.useSyncExternalStore(
        source && presented ? source.subscribe : subscribeToNothing,
        source && presented ? source.read : readPointerModality,
        readPointerModality,
    );
}
