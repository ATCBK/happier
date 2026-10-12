import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

export type HappyActionMode = 'drop' | 'rerun_latest';

export function useHappyAction<Args extends unknown[]>(action: (...args: Args) => Promise<void>, options?: Readonly<{ mode?: HappyActionMode }>) {
    const [loading, setLoading] = React.useState(false);
    const loadingRef = React.useRef(false);
    const pendingRerunRef = React.useRef<Args | null>(null);
    const mountedRef = useMountedRef();
    const mode: HappyActionMode = options?.mode ?? 'drop';
    const doActionRef = React.useRef<null | ((...args: Args) => void)>(null);

    const setLoadingSafe = React.useCallback((value: boolean) => {
        if (!mountedRef.current) return;
        setLoading(value);
    }, [mountedRef]);

    const doAction = React.useCallback((...args: Args) => {
        if (loadingRef.current) {
            if (mode === 'rerun_latest') {
                pendingRerunRef.current = args;
            }
            return;
        }
        loadingRef.current = true;
        setLoadingSafe(true);
        (async () => {
            try {
                while (true) {
                    try {
                        await action(...args);
                        break;
                    } catch (e) {
                        if (e instanceof HappyError) {
                            // if (e.canTryAgain) {
                            //     Modal.alert('Error', e.message, [{ text: 'Try again' }, { text: 'Cancel', style: 'cancel' }]) 
                            //         break;
                            //     }
                            // } else {
                            //     await alert('Error', e.message, [{ text: 'OK', style: 'cancel' }]);
                            //     break;
                            // }
                            Modal.alert(t('common.error'), e.message, [{ text: t('common.ok'), style: 'cancel' }]);
                            break;
                        } else {
                            const shown = tryShowDaemonUnavailableAlertForRpcError({
                                error: e,
                                onRetry: () => {
                                    void doAction(...args);
                                },
                                shouldContinue: () => mountedRef.current,
                                titleKey: 'errors.daemonUnavailableTitle',
                                bodyKey: 'errors.daemonUnavailableBody',
                            });
                            if (!shown) {
                                Modal.alert(t('common.error'), t('errors.unknownError'), [{ text: t('common.ok'), style: 'cancel' }]);
                            }
                            break;
                        }
                    }
                }
            } finally {
                loadingRef.current = false;
                setLoadingSafe(false);

                if (mode === 'rerun_latest' && pendingRerunRef.current) {
                    const pendingArgs = pendingRerunRef.current;
                    pendingRerunRef.current = null;
                    // Rerun on a later tick so we don't recurse within the same call stack.
                    // This keeps state updates predictable and avoids surprising sync reentrancy.
                    Promise.resolve().then(() => {
                        if (!mountedRef.current) return;
                        doActionRef.current?.(...pendingArgs);
                    });
                }
            }
        })();
    }, [action, mode, mountedRef, setLoadingSafe]);

    doActionRef.current = doAction;

    return [loading, doAction] as const;
}
