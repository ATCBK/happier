import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

const { createTranscriptFindModel } = await import('./useTranscriptFind');
const { TranscriptFindRuler } = await import('./TranscriptFindRuler');

const message = (id: string, text: string, seq: number): Message => ({ kind: 'user-text', id, localId: null, createdAt: seq, seq, text });
const rows: Record<string, { y: number; height: number }> = { a: { y: 100, height: 50 }, b: { y: 900, height: 50 }, c: { y: 1500, height: 50 } };

describe('transcript Find overview ruler', () => {
    it('allows native list measurement to publish layout without updating its coordinator during render', async () => {
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('a', 'needle', 1)],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: async () => ({ status: 'not-found', reason: 'unsupported' }), reveal: async () => {},
        });
        function LayoutCoordinator() {
            const [measurementVersion, setMeasurementVersion] = React.useState(0);
            const published = React.useRef(false);
            // Native/virtualized layout reads can publish newly measured geometry.
            const measureMessage = React.useCallback((id: string) => {
                if (!published.current) {
                    published.current = true;
                    setMeasurementVersion(version => version + 1);
                }
                return rows[id] ?? null;
            }, []);
            return <View accessibilityLabel={`layout-${measurementVersion}`}>
                <TranscriptFindRuler model={model} contentHeight={2000} olderRemaining={false} measureMessage={measureMessage} />
            </View>;
        }
        const screen = await renderScreen(<LayoutCoordinator />);
        const errors = vi.spyOn(console, 'error');
        try {
            await act(async () => {
                screen.findByTestId('transcript-find-ruler')!.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
            });
            errors.mockClear();
            await act(async () => { model.setQuery('needle'); });
            expect(screen.findByTestId('transcript-find-ruler-current')?.props.style)
                .toEqual(expect.arrayContaining([expect.objectContaining({ top: 10 })]));
            expect(errors).not.toHaveBeenCalled();
        } finally {
            errors.mockRestore();
            await screen.unmount();
            model.dispose();
        }
    });

    it('marks every matched row on the scroll edge, follows the current match, and caps unsearched older history', async () => {
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [message('a', 'needle', 1), message('b', 'other', 2), message('c', 'needle', 3)],
                history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: async () => ({ status: 'not-found', reason: 'unsupported' }), reveal: async () => {},
        });
        const screen = await renderScreen(<TranscriptFindRuler model={model} contentHeight={2000} olderRemaining
            measureMessage={(id) => rows[id] ?? null} />);
        await act(async () => { screen.findByTestId('transcript-find-ruler')!.props.onLayout({ nativeEvent: { layout: { height: 200 } } }); });
        expect(screen.findByTestId('transcript-find-ruler-current')).toBeNull();
        await act(async () => { model.setQuery('needle'); });
        const current = () => screen.findByTestId('transcript-find-ruler-current');
        expect(current()?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ top: 10 })]));
        await act(async () => { model.step(1); });
        expect(current()?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ top: 150 })]));
        expect(screen.findByTestId('transcript-find-ruler-older')).not.toBeNull();
    });
});
