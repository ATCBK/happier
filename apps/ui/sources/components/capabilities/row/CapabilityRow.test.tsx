import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => {
    standardCleanup();
    vi.resetModules();
});

const facts = { presentation: 'row' as const, source: { kind: 'git' as const, label: 'anthropics/skills' }, trust: 'runs_scripts' as const };

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    return screen.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children as string).join('|');
}

describe('CapabilityRow', () => {
    it('lets a speaking status take the facts line, and keeps the facts while healthy', async () => {
        const { CapabilityRow } = await import('./CapabilityRow');
        const healthy = await renderScreen(<CapabilityRow title="docx" description="Word documents." facts={facts} testID="row" />);
        expect(texts(healthy)).toContain('anthropics/skills');
        expect(healthy.findAll((node) => node.props?.testID === 'row:status')).toHaveLength(0);

        const blocked = await renderScreen(<CapabilityRow title="docx" description="Word documents." facts={facts} status={{ kind: 'error' }} testID="row" />);
        expect(blocked.findAll((node) => node.props?.testID === 'row:status').length).toBeGreaterThan(0);
        expect(texts(blocked)).not.toContain('anthropics/skills');

        // A silent status (ready) keeps the facts.
        const ready = await renderScreen(<CapabilityRow title="docx" facts={facts} status={{ kind: 'ready' }} testID="row" />);
        expect(texts(ready)).toContain('anthropics/skills');
    });

    it('counts one tool in the singular and several in the plural', async () => {
        const { CapabilityRow } = await import('./CapabilityRow');
        const one = await renderScreen(<CapabilityRow title="fetch" facts={{ presentation: 'row', cost: { toolCount: 1 } }} testID="row" />);
        expect(texts(one)).toContain('1 tool');
        expect(texts(one)).not.toContain('1 tools');
        const many = await renderScreen(<CapabilityRow title="fetch" facts={{ presentation: 'row', cost: { toolCount: 2 } }} testID="row" />);
        expect(texts(many)).toContain('2 tools');
    });

    it('draws the scope as its own column before the action in menu density, not on the title line', async () => {
        const { CapabilityRow } = await import('./CapabilityRow');
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(
            <CapabilityRow title="docx" whereSummary="Everywhere" action={<Text testID="action">Add</Text>} density="menu" testID="row" />,
        );
        const scope = screen.findAll((node) => node.props?.testID === 'row:scope');
        expect(scope.length).toBeGreaterThan(0);
        const columns = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0
            && node.findAll((child) => child.props?.testID === 'action').length > 0
            && node.findAll((child) => child.props?.children === 'docx').length === 0);
        expect(columns.length).toBeGreaterThan(0);
    });

    it('recomposes menu density on a narrow row: the status alone on line 2, the scope on line 3, the action still right', async () => {
        const { act } = await import('react');
        const { CapabilityRow } = await import('./CapabilityRow');
        const { Text } = await import('@/components/ui/text/Text');
        const screen = await renderScreen(
            <CapabilityRow title="github" description="Issues and pull requests." whereSummary="Everywhere" status={{ kind: 'signin' }}
                action={<Text testID="action">Sign in</Text>} density="menu" testID="row" />,
        );
        const outer = screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function'
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0)[0]!;
        await act(async () => {
            outer.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 64 } } });
        });
        // No scope column beside the action any more.
        const columns = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0
            && node.findAll((child) => child.props?.testID === 'action').length > 0
            && node.findAll((child) => child.props?.children === 'github').length === 0);
        expect(columns).toHaveLength(0);
        // The status is the one line under the name (no description), and the scope follows it.
        expect(texts(screen)).not.toContain('Issues and pull requests.');
        const lines = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'row:status').length > 0
            && node.findAll((child) => child.props?.testID === 'row:scope').length > 0)
            .at(-1)!;
        const order = lines.findAll((child) => child.props?.testID === 'row:status' || child.props?.testID === 'row:scope')
            .map((child) => child.props.testID as string);
        expect(order.indexOf('row:status')).toBeLessThan(order.indexOf('row:scope'));
        expect(screen.findAll((node) => node.props?.testID === 'action').length).toBeGreaterThan(0);
    });
    it('joins the scope to the facts on one narrow line, scope first ("Everywhere · 1.2k tokens")', async () => {
        const { act } = await import('react');
        const { CapabilityRow } = await import('./CapabilityRow');
        const screen = await renderScreen(
            <CapabilityRow title="pdf" whereSummary="Everywhere" facts={{ presentation: 'row', cost: { tokensWhenUsed: 1200 } }} density="menu" testID="row" />,
        );
        const outer = screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function')[0]!;
        await act(async () => {
            outer.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 64 } } });
        });
        const words = texts(screen);
        expect(words).toContain('Everywhere');
        expect(words).toMatch(/tokens/);
        expect(words.indexOf('Everywhere')).toBeLessThan(words.search(/tokens/));
    });
    it('says a stopped server short in its pill and its reason whole on the next line', async () => {
        const { CapabilityRow } = await import('./CapabilityRow');
        const reason = "its sign-in couldn't be passed to this session";
        const screen = await renderScreen(
            <CapabilityRow title="linear" density="menu" status={{ kind: 'error', machineName: 'nl2', detail: reason }} testID="row" />,
        );
        const words = texts(screen);
        expect(words).toContain(reason);
        // The pill carries the short state only; the reason is not inside a one-line, truncating text.
        const truncating = screen.findAll((node) => node.props?.numberOfLines === 1 && JSON.stringify(node.props.children ?? '').includes(reason));
        expect(truncating).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.children === reason && node.props.numberOfLines === undefined).length).toBeGreaterThan(0);
    });
});
