import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
    TranscriptSameSessionHandoffProvider,
    type TranscriptExitEntrySnapshot,
    type TranscriptSameSessionHandoffRoute,
    useTranscriptSameSessionHandoffRoute,
    useTranscriptSameSessionHandoff,
} from './transcriptSameSessionHandoff';

function anchored(itemOffsetPx: number, capturedAtMs: number): TranscriptExitEntrySnapshot {
    return {
        anchor: {
            kind: 'message',
            messageId: 'm2',
            itemId: 'm2',
            itemOffsetPx,
            capturedAtMs,
        },
        capturedAtMs,
        isPinned: false,
        offsetY: 500,
        shouldRestoreViewport: true,
    };
}

describe('transcriptSameSessionHandoff', () => {
    it('discards the replacement snapshot when the same transcript survives the experience change', async () => {
        const routeRef: { current: TranscriptSameSessionHandoffRoute | null } = { current: null };
        const sessionKey = '["server-a","session-a"]';
        function RetainedTranscript() {
            const route = useTranscriptSameSessionHandoffRoute();
            const captureForHandoff = React.useCallback(() => ({
                source: 'physical-exit' as const, viewport: anchored(40, 10),
            }), []);
            useTranscriptSameSessionHandoff({ captureForHandoff, explicitJump: false, sessionKey });
            React.useLayoutEffect(() => { routeRef.current = route; }, [route]);
            return null;
        }
        const body = (experience: 'classic' | 'cockpit') => <TranscriptSameSessionHandoffProvider
            desiredExperience={experience} sessionAddressKey={sessionKey}>
            {() => <RetainedTranscript />}
        </TranscriptSameSessionHandoffProvider>;
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(body('classic')); });
        try {
            await act(async () => { tree.update(body('cockpit')); });
            expect(routeRef.current?.peekForRender({
                incomingMountToken: {}, sessionKey, toExperience: 'cockpit',
            })).toBeNull();
        } finally {
            await act(async () => { tree.unmount(); });
        }
    });

    it('preserves one exact Session surface but discards address-local state when the Home changes', async () => {
        const mountedTokens: object[] = [];

        function StatefulSurface() {
            const [token] = React.useState(() => ({}));
            mountedTokens.push(token);
            return null;
        }

        function Route(props: Readonly<{ sessionAddressKey: string }>) {
            return (
                <TranscriptSameSessionHandoffProvider
                    desiredExperience="classic"
                    sessionAddressKey={props.sessionAddressKey}
                >
                    {() => <StatefulSurface />}
                </TranscriptSameSessionHandoffProvider>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Route sessionAddressKey='["server-a","same"]' />);
        });
        const serverAToken = mountedTokens.at(-1);

        await act(async () => {
            tree.update(<Route sessionAddressKey='["server-a","same"]' />);
        });
        expect(mountedTokens.at(-1)).toBe(serverAToken);

        await act(async () => {
            tree.update(<Route sessionAddressKey='["server-b","same"]' />);
        });
        expect(mountedTokens.at(-1)).not.toBe(serverAToken);
    });

    it('stages a desired-experience change, refreshes at deletion, and claims once', async () => {
        const routeRef: { current: TranscriptSameSessionHandoffRoute | null } = { current: null };
        const outgoingToken = {};
        const incomingToken = {};
        const rendered: TranscriptExitEntrySnapshot[] = [];
        const claimed: TranscriptExitEntrySnapshot[] = [];
        let captureCount = 0;

        function Probe() {
            const route = useTranscriptSameSessionHandoffRoute();
            React.useLayoutEffect(() => {
                routeRef.current = route;
                return () => {
                    routeRef.current = null;
                };
            }, [route]);
            return null;
        }

        function Producer() {
            const route = useTranscriptSameSessionHandoffRoute();
            const capture = React.useCallback(() => ({
                source: 'physical-exit' as const,
                viewport: captureCount++ === 0 ? anchored(40, 10) : anchored(55, 20),
            }), []);
            React.useLayoutEffect(() => {
                const unregister = route.registerProducer({
                    captureForHandoff: capture,
                    experience: 'classic',
                    mountToken: outgoingToken,
                    sessionKey: '["server-a","session-a"]',
                });
                return () => {
                    route.refreshForDeletion({
                        producerMountToken: outgoingToken,
                        selection: capture(),
                        sessionKey: '["server-a","session-a"]',
                    });
                    unregister();
                };
            }, [capture, route]);
            return null;
        }

        function Consumer() {
            const route = useTranscriptSameSessionHandoffRoute();
            const peeked = route.peekForRender({
                incomingMountToken: incomingToken,
                sessionKey: '["server-a","session-a"]',
                toExperience: 'cockpit',
            });
            if (peeked) rendered.push(peeked.viewport);
            React.useInsertionEffect(() => {
                const handoff = route.claimAfterCommit({
                    incomingMountToken: incomingToken,
                    sessionKey: '["server-a","session-a"]',
                    toExperience: 'cockpit',
                });
                if (handoff) claimed.push(handoff.viewport);
            }, [route]);
            return null;
        }

        function Route(props: Readonly<{ experience: 'classic' | 'cockpit' }>) {
            return (
                <TranscriptSameSessionHandoffProvider
                    desiredExperience={props.experience}
                    sessionAddressKey='["server-a","session-a"]'
                >
                    {(experience) => (
                        <>
                            <Probe />
                            {experience === 'classic' ? <Producer /> : <Consumer />}
                        </>
                    )}
                </TranscriptSameSessionHandoffProvider>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Route experience="classic" />);
        });
        await act(async () => {
            tree.update(<Route experience="cockpit" />);
        });

        expect(rendered).toEqual([anchored(40, 10)]);
        expect(claimed).toEqual([anchored(55, 20)]);
        expect(routeRef.current?.claimAfterCommit({
            incomingMountToken: incomingToken,
            sessionKey: '["server-a","session-a"]',
            toExperience: 'cockpit',
        })).toBeNull();
    });
});
