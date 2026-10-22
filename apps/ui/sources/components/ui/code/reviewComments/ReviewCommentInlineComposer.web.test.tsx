// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installCodeViewCommonModuleMocks } from '../view/codeViewTestHelpers';

installCodeViewCommonModuleMocks({ reactNative: async () => import('react-native-web') });
const { ReviewCommentInlineComposer } = await import('./ReviewCommentInlineComposer');

it('exposes enabled, named comment commands at the real web boundary and keeps Delete optional', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const save = vi.fn(), cancel = vi.fn(), remove = vi.fn();
    const render = (onDelete?: () => void) => act(async () => root.render(
        <ReviewCommentInlineComposer value="" onChange={() => {}} onSave={save} onCancel={cancel} onDelete={onDelete} />,
    ));
    try {
        await render(remove);
        for (const [name, handler] of [['Cancel', cancel], ['Save', save], ['Delete', remove]] as const) {
            const command = host.querySelector<HTMLElement>(`[role="button"][aria-label="${name}"]`);
            expect(command, `${name} must be an accessible button`).not.toBeNull();
            expect(command!.getAttribute('aria-disabled')).not.toBe('true');
            expect(command!.tabIndex).toBe(0);
            await act(async () => command!.click());
            expect(handler).toHaveBeenCalledOnce();
        }
        // An empty draft does not introduce a new disabled-Save policy.
        expect(save).toHaveBeenCalledOnce();
        const keyboardCancel = host.querySelector<HTMLElement>('[role="button"][aria-label="Cancel"]')!;
        await act(async () => keyboardCancel.focus());
        expect(document.activeElement).toBe(keyboardCancel);
        await render();
        expect(host.querySelector('[role="button"][aria-label="Delete"]')).toBeNull();
        expect(host.querySelectorAll('[role="button"]')).toHaveLength(2);
    } finally {
        await act(async () => root.unmount()); host.remove();
    }
});
