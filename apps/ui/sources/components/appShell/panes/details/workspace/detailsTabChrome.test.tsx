import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { unsavedWorkspaceFilePaths, useDetailsTabUnsavedKeys } from './detailsTabChrome';
import type { DetailsTabState } from './detailsWorkspaceTypes';

describe('Details unsaved tab chrome', () => {
    it('lists persisted drafts for inactive, unmounted and other-group file tabs while checking Account ownership', () => {
        const tab = (key: string): DetailsTabState => ({ key, kind: 'file', title: key, resource: { path: `${key}.ts` }, isPinned: true, isPreview: false });
        const a = tab('a'); const b = tab('b'); const c = tab('c');
        const draft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'draft' };
        const details = {
            tabs: [a, b], tabState: { a: draft, b: draft, c: draft, foreign: { ...draft, accountId: 'bob' }, closed: draft },
            groups: [
                { id: 'one', tabKeys: ['a', 'b'], activeTabKey: 'a', tabs: [a, b], isFocused: true },
                { id: 'two', tabKeys: ['c', 'foreign'], activeTabKey: 'c', tabs: [c, tab('foreign')], isFocused: false },
            ],
        };
        expect(unsavedWorkspaceFilePaths({ accountId: 'alice', details })).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(unsavedWorkspaceFilePaths({ accountId: null, details })).toEqual([]);
    });
    it('pins a preview only when its unsaved state becomes true', async () => {
        const pinTab = vi.fn();
        const hook = await renderHook(() => useDetailsTabUnsavedKeys(pinTab));
        const chrome = hook.getCurrent().chromeFor('file:a');
        await act(async () => chrome.setUnsaved(true));
        expect(pinTab).toHaveBeenCalledWith('file:a');
        expect(hook.getCurrent().unsavedKeys.has('file:a')).toBe(true);
        await act(async () => chrome.setUnsaved(true));
        expect(pinTab).toHaveBeenCalledTimes(1);
        await act(async () => chrome.setUnsaved(false));
        expect(hook.getCurrent().unsavedKeys.size).toBe(0);
    });
});
