import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installScanRouteCommonModuleMocks,
} from './scanRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const promptSpy = vi.fn(async (..._args: unknown[]) => null as string | null);
const alertAsyncSpy = vi.fn(async (..._args: unknown[]) => undefined);
let lastTerminalConnectOptions: any = null;
installScanRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: routerBackSpy,
                replace: routerReplaceSpy,
                canGoBack: () => false,
            },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: (...args: unknown[]) => promptSpy(...args),
                alertAsync: (...args: unknown[]) => alertAsyncSpy(...args),
            },
        }).module;
    },
});

const processTerminalAuthUrlSpy = vi.fn(async (_url: string) => true);
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: (opts?: any) => {
        lastTerminalConnectOptions = opts ?? null;
        return { processAuthUrl: processTerminalAuthUrlSpy, isLoading: false };
    },
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        // The real view renders `footer` in the granted, denied and unavailable
        // branches alike; rendering it here keeps the camera-denial paste path
        // reachable from these route tests.
        return React.createElement('QrCodeScannerView', props, props.footer);
    },
}));

vi.mock('@/components/onboarding/ui/WizardModalShell', () => ({
    WizardModalShell: (props: any) => React.createElement('WizardModalShell', props, props.children),
}));

// The scanner's connection warning reads the app's auth owner; load it after the module mocks above.
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
function renderScanRoute(element: React.ReactElement) {
    return renderScreen(<InjectedAuthProvider credentials={null}>{element}</InjectedAuthProvider>);
}

describe('/scan/terminal', () => {
    beforeEach(() => {
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        promptSpy.mockClear();
        alertAsyncSpy.mockClear();
        processTerminalAuthUrlSpy.mockClear();
        lastScannerProps = null;
        lastTerminalConnectOptions = null;
    });

    it('renders the terminal scan wizard shell and terminal-specific scanner copy', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        const screen = await renderScanRoute(<Screen />);

        const wizard = screen.findByType('WizardModalShell' as never);
        expect(wizard.props.testID).toBe('scan-terminal-wizard');
        expect(wizard.props.stepIndex).toBe(0);
        expect(wizard.props.stepCount).toBe(1);
        expect(wizard.props.showSkip).toBe(false);
        expect(wizard.props.title).toBe('modals.authenticateTerminal');
        expect(wizard.props.subtitle).toBe('connect.scanQrCodeOnDevice');

        expect(lastScannerProps?.embedded).toBe(true);
        expect(lastScannerProps?.title).toBe('modals.authenticateTerminal');
        expect(lastScannerProps?.subtitle).toBe('connect.scanQrCodeOnDevice');
        expect(lastScannerProps?.permissionRequiredMessage).toBe('modals.cameraPermissionsRequiredToConnectTerminal');
    });

    it('processes scanned terminal URLs', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScanRoute(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(processTerminalAuthUrlSpy).toHaveBeenCalledTimes(1);
        expect(processTerminalAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc&server=https%3A%2F%2Fapi.happier.dev');
    });

    it('rejects scanned account URLs from the terminal scanner', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScanRoute(<Screen />);

        expect(typeof lastScannerProps?.onScan).toBe('function');

        await act(async () => {
            await lastScannerProps.onScan('happier:///account?abc123');
        });

        expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
        expect(alertAsyncSpy).toHaveBeenCalledWith('common.error', 'modals.invalidAuthUrl', [{ text: 'common.ok' }]);
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
    });

    it('keeps the terminal manual-entry copy on the canonical full-screen form', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        const screen = await renderScanRoute(<Screen />);

        expect(screen.findAllByTestId('pairing-link-entry-form')).toHaveLength(0);

        await screen.pressByTestIdAsync('scan-terminal-enter-url');

        expect(promptSpy).not.toHaveBeenCalled();
        expect(screen.findAllByTestId('pairing-link-entry-form').length).toBeGreaterThan(0);
        expect(screen.findAllByType('QrCodeScannerView' as never)).toHaveLength(0);

        const text = screen.getTextContent();
        expect(text).toContain('modals.authenticateTerminal');
        expect(text).toContain('modals.pasteUrlFromTerminal');
        const input = screen.findHostByTestId('restore-pairing-link-input');
        expect(input?.props.placeholder).toBe('connect.terminalUrlPlaceholder');
        expect(input?.props.autoFocus).toBe(true);
        const submit = screen.findByTestId('restore-pairing-link-submit');
        if (!submit) throw new Error('Expected the terminal link form submit button');
        expect(submit.props.title).toBe('common.authenticate');
    });

    it('submits a pasted terminal link through the shared scan processor', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        const screen = await renderScanRoute(<Screen />);
        await screen.pressByTestIdAsync('scan-terminal-enter-url');

        await act(async () => {
            screen.changeTextByTestId(
                'restore-pairing-link-input',
                '  happier://terminal?key=manual&server=https%3A%2F%2Fapi.happier.dev  ',
            );
        });
        await act(async () => {
            const submit = screen.findByTestId('restore-pairing-link-submit');
            if (!submit) throw new Error('Expected the terminal link form submit button');
            await submit.props.action();
        });

        expect(promptSpy).not.toHaveBeenCalled();
        expect(processTerminalAuthUrlSpy).toHaveBeenCalledWith('happier://terminal?key=manual&server=https%3A%2F%2Fapi.happier.dev');
    });

    it('rejects a pasted account URL from the terminal form with an inline alert and a retained draft', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        const screen = await renderScanRoute(<Screen />);
        await screen.pressByTestIdAsync('scan-terminal-enter-url');

        await act(async () => {
            screen.changeTextByTestId('restore-pairing-link-input', 'happier:///account?abc123');
        });
        await act(async () => {
            const submit = screen.findByTestId('restore-pairing-link-submit');
            if (!submit) throw new Error('Expected the terminal link form submit button');
            await submit.props.action();
        });

        expect(alertAsyncSpy).toHaveBeenCalledWith('common.error', 'modals.invalidAuthUrl', [{ text: 'common.ok' }]);
        expect(processTerminalAuthUrlSpy).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('restore-pairing-link-error')?.props.accessibilityRole).toBe('alert');
        expect(screen.findHostByTestId('restore-pairing-link-input')?.props.value).toBe('happier:///account?abc123');
    });

    it('returns to the camera from the pairing link form without leaving the route', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        const screen = await renderScanRoute(<Screen />);
        await screen.pressByTestIdAsync('scan-terminal-enter-url');
        await screen.pressByTestIdAsync('restore-pairing-link-back');

        expect(screen.findAllByTestId('pairing-link-entry-form')).toHaveLength(0);
        expect(screen.findAllByType('QrCodeScannerView' as never).length).toBeGreaterThan(0);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('uses safe fallback navigation after a successful terminal approval when there is no back stack', async () => {
        const { default: Screen } = await import('@/app/(app)/scan/terminal');

        await renderScanRoute(<Screen />);

        expect(typeof lastTerminalConnectOptions?.onSuccess).toBe('function');

        await act(async () => {
            await lastTerminalConnectOptions.onSuccess();
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });
});
