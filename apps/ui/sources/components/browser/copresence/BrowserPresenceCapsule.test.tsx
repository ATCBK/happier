import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { BrowserPresenceCapsule } from './BrowserPresenceCapsule';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

const agent = { agentId: null, name: 'Claude' } as const;

describe('BrowserPresenceCapsule', () => {
    it('narrates the accessible target for a labeled click', async () => {
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'agent', activity: 'click', target: { x: 0.5, y: 0.4, label: 'Sign in' }, controlEpoch: 0 }} agent={agent} />,
        );
        expect(screen.getTextContent()).toContain('Sign in');
    });
    it('stops on Take control and shows the stopping state until the owner moves the control epoch', async () => {
        const onTakeControl = vi.fn();
        const presence = { kind: 'agent', activity: 'click', target: null, controlEpoch: 4 } as const;
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={presence} agent={agent} onTakeControl={onTakeControl} onHandBack={vi.fn()} />,
        );
        await screen.pressByTestIdAsync('p-take-control');
        expect(onTakeControl).toHaveBeenCalledTimes(1);
        expect(screen.findHostByTestId('p-stopping')).toBeTruthy();

        await screen.update(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'human', controlEpoch: 5, interruptedCompletion: null }} agent={agent} onTakeControl={onTakeControl} onHandBack={vi.fn()} />,
        );
        expect(screen.findHostByTestId('p-human')).toBeTruthy();
        expect(screen.findHostByTestId('p-hand-back')).toBeTruthy();
    });

    it('offers no buttons it cannot honour: no takeover route and no hand back route', async () => {
        const agentScreen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'agent', activity: null, target: null, controlEpoch: 0 }} agent={agent} />,
        );
        expect(agentScreen.findHostByTestId('p-take-control')).toBeNull();

        const humanScreen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'human', controlEpoch: 1, interruptedCompletion: null }} agent={agent} />,
        );
        expect(humanScreen.findHostByTestId('p-hand-back')).toBeNull();
        expect(humanScreen.getTextContent()).not.toContain('browserPresence.pausedUntilHandBack');
    });

    it('stays stopping while the owner settles the interrupted action, then says its effect is unknown', async () => {
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'stopping', controlEpoch: 2 }} agent={agent} onTakeControl={vi.fn()} onHandBack={vi.fn()} />,
        );
        expect(screen.findHostByTestId('p-stopping')).toBeTruthy();
        expect(screen.findHostByTestId('p-take-control')).toBeNull();
        expect(screen.findHostByTestId('p-hand-back')).toBeNull();

        await screen.update(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'human', controlEpoch: 2, interruptedCompletion: 'unknown' }} agent={agent} onTakeControl={vi.fn()} onHandBack={vi.fn()} />,
        );
        expect(screen.findHostByTestId('p-human')).toBeTruthy();
        expect(screen.getTextContent()).toContain('browserPresence.lastActionMayHaveLanded');
        expect(screen.findHostByTestId('p-hand-back')).toBeTruthy();
    });

    it('says the interrupted action may have landed and still offers Hand back (it is never a refusal)', async () => {
        const onHandBack = vi.fn();
        const onCheckAgain = vi.fn();
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'human', controlEpoch: 2, interruptedCompletion: 'unknown' }} agent={agent} onTakeControl={vi.fn()} onHandBack={onHandBack} onCheckAgain={onCheckAgain} />,
        );
        expect(screen.findHostByTestId('p-human')).toBeTruthy();
        expect(screen.getTextContent()).toContain('browserPresence.lastActionMayHaveLanded');
        await screen.pressByTestIdAsync('p-check-again');
        expect(onCheckAgain).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('p-hand-back');
        expect(onHandBack).toHaveBeenCalledTimes(1);
    });

    it('never says you have control when the stop is unconfirmed, and offers the fresh look that confirms it', async () => {
        const onCheckAgain = vi.fn();
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'unconfirmed', controlEpoch: 2 }} agent={agent} onTakeControl={vi.fn()} onHandBack={vi.fn()} onCheckAgain={onCheckAgain} />,
        );
        expect(screen.findHostByTestId('p-unconfirmed')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('browserPresence.youHaveControl');
        expect(screen.getTextContent()).toContain('browserPresence.stopUnconfirmed');
        expect(screen.getTextContent()).toContain('browserPresence.lastActionMayHaveLanded');
        await screen.pressByTestIdAsync('p-check-again');
        expect(onCheckAgain).toHaveBeenCalledTimes(1);
        // Handing back stays possible: the owner makes the agent look again before it acts.
        expect(screen.findHostByTestId('p-hand-back')).toBeTruthy();
    });

    it('sits in flow as the session-wide line, with Watch beside the one control', async () => {
        const onWatch = vi.fn();
        const onTakeControl = vi.fn();
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" placement="inline" presence={{ kind: 'agent', activity: null, target: null, controlEpoch: 1 }} agent={agent} onTakeControl={onTakeControl} onWatch={onWatch} />,
        );
        await screen.pressByTestIdAsync('p-watch');
        expect(onWatch).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('p-take-control');
        expect(onTakeControl).toHaveBeenCalledTimes(1);
    });

    it('renders nothing while nobody drives the page', async () => {
        const screen = await renderScreen(
            <BrowserPresenceCapsule testID="p" presence={{ kind: 'idle', controlEpoch: 0 }} agent={agent} />,
        );
        expect(screen.tree.toJSON()).toBeNull();
    });
});
