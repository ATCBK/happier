import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';

import { useComposerPresentationInputEffects } from './useComposerPresentationInputEffects';

describe('useComposerPresentationInputEffects', () => {
    it('keeps the decoration projection identity across renders that change no decoration', async () => {
        const ref = { kind: 'session', sessionId: 'session-1' } as const;
        const hook = await renderHook((props: { tick: number }) => {
            void props.tick;
            return useComposerPresentationInputEffects({ ref });
        }, { initialProps: { tick: 0 } });
        const first = hook.getCurrent().composerDecorations;

        await hook.rerender({ tick: 1 });

        // The composer editor treats a new decorations array as a presentation change.
        expect(hook.getCurrent().composerDecorations).toBe(first);
    });
});
