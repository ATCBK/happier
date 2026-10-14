import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createPortalMock = vi.hoisted(() => vi.fn((node: any) => node));

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    const radix = createRadixCjsModuleMock();
    return {
        ...radix,
        requireRadixDismissableLayer: () => ({
            ...radix.requireRadixDismissableLayer(),
            Branch: ({ children, ...rest }: any) => React.createElement('Branch', rest, children),
        }),
    };
});

vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({
        createPortal: createPortalMock,
    }),
}));

// Resolve the cold modal graph before the portal assertions start their deadlines.
const { BaseModal } = await import('./BaseModal');
const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');

describe('BaseModal web portal target', () => {
    it('defaults to document.body on web when webPortalTarget is omitted', async () => {
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        (globalThis as any).document = {
            body: { nodeType: 1, style: {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;
        const expectedPortalTarget = (globalThis as any).document.body;

        try {
            await renderScreen(
                <BaseModal visible={true}>
                    <div />
                </BaseModal>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(expectedPortalTarget);
    });

    it('inherits the nearest modal portal target when the prop is omitted', async () => {
        const inheritedPortalTarget = { nodeType: 1 } as unknown as Element;
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        (globalThis as any).document = {
            body: { nodeType: 1, style: {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;

        try {
            await renderScreen(
                <ModalPortalTargetProvider target={inheritedPortalTarget}>
                    <BaseModal visible={true}>
                        <div />
                    </BaseModal>
                </ModalPortalTargetProvider>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(inheritedPortalTarget);
    });

    it('stacks above every screen popover layer: a body-level popover host is not its portal target', async () => {
        // A dialog opened from inside a popover (Add → Session, Add → confirm) must sit above it whatever
        // order the screens' popover hosts were appended to the body in.
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        const body = { nodeType: 1, style: {} };
        (globalThis as any).document = {
            body,
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;
        const screenPopoverHost = {
            nodeType: 1,
            parentElement: body,
            hasAttribute: (name: string) => name === 'data-happy-popover-portal-host',
        } as unknown as Element;

        try {
            await renderScreen(
                <ModalPortalTargetProvider target={screenPopoverHost}>
                    <BaseModal visible={true}>
                        <div />
                    </BaseModal>
                </ModalPortalTargetProvider>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(body);
    });

    it('renders into the provided web portal target when supplied', async () => {
        const portalTarget = { nodeType: 1 } as unknown as Element;
        const inheritedPortalTarget = { nodeType: 11 } as unknown as DocumentFragment;
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        (globalThis as any).document = {
            body: { nodeType: 1, style: {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;

        try {
            await renderScreen(
                <ModalPortalTargetProvider target={inheritedPortalTarget}>
                    <BaseModal visible={true} webPortalTarget={portalTarget}>
                        <div />
                    </BaseModal>
                </ModalPortalTargetProvider>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(portalTarget);
    });
});
