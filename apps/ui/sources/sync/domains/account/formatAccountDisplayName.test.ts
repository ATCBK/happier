import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) =>
        (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { formatAccountDisplayName, resolveAccountDisplayName, resolveViewerAccountDisplayName } from './formatAccountDisplayName';

const UNNAMED = { name: null, firstName: null, lastName: null, username: null, avatarUrl: null } as const;

describe('formatAccountDisplayName', () => {
    it('uses trimmed current names before username, with an explicit unnamed result', () => {
        const named = { ...UNNAMED, name: ' Alice Chen ', firstName: 'Old', lastName: 'Name', username: 'alice' };
        const usernameOnly = { ...UNNAMED, name: ' ', firstName: 'Old', username: ' alice ' };
        const unnamed = { ...UNNAMED, firstName: 'Old', username: ' ' };
        expect(formatAccountDisplayName(named)).toBe('Alice Chen');
        expect(formatAccountDisplayName(usernameOnly)).toBe('alice');
        expect(formatAccountDisplayName(unnamed)).toBeNull();
    });
});

describe('resolveAccountDisplayName', () => {
    it('names a named Account by its name, with no hint', () => {
        expect(resolveAccountDisplayName({ profile: { ...UNNAMED, name: 'Ada' }, accountId: 'cmn0a0oa40001tmj4izjp8qkg' }))
            .toEqual({ name: 'Ada', hint: null, named: true, viewer: false });
    });

    it('never shows the raw id: an unnamed Account is "Unnamed account" with a short stable id hint', () => {
        const presentation = resolveAccountDisplayName({ profile: UNNAMED, accountId: 'cmn0a0oa40001tmj4izjp8qkg' });
        expect(presentation.name).toBe('accountDisplay.unnamed');
        expect(presentation.named).toBe(false);
        expect(presentation.hint).toBe('accountDisplay.shortId:{"id":"p8qkg"}');
        expect(JSON.stringify(presentation)).not.toContain('cmn0a0oa40001tmj4izjp8qkg');
        // Stable: the same Account always gets the same hint.
        expect(resolveAccountDisplayName({ profile: UNNAMED, accountId: 'cmn0a0oa40001tmj4izjp8qkg' })).toEqual(presentation);
    });

    it('prefers a sign-in email the caller already holds over the id as the hint', () => {
        expect(resolveAccountDisplayName({ profile: UNNAMED, accountId: 'cmn0a0oa40001tmj4izjp8qkg', signInEmail: 'ada@example.test' }))
            .toEqual({ name: 'accountDisplay.unnamed', hint: 'ada@example.test', named: false, viewer: false });
    });

    it('falls back to "Unnamed account" when no profile is readable', () => {
        expect(resolveAccountDisplayName({ profile: null, accountId: 'abc' }).name).toBe('accountDisplay.unnamed');
    });
});

describe('resolveAccountDisplayName for the viewer', () => {
    it('names the viewer\'s own unnamed Account "Your account", with no hint about themselves', () => {
        expect(resolveAccountDisplayName({
            profile: UNNAMED, accountId: 'cmn0a0oa40001tmj4izjp8qkg', signInEmail: 'me@example.test', viewerAccountId: 'cmn0a0oa40001tmj4izjp8qkg',
        })).toEqual({ name: 'accountDisplay.yours', hint: null, named: false, viewer: true });
    });

    it('names a named viewer by their name, and anyone else as before', () => {
        expect(resolveAccountDisplayName({ profile: { ...UNNAMED, name: 'Ada' }, accountId: 'me', viewerAccountId: 'me' }))
            .toEqual({ name: 'Ada', hint: null, named: true, viewer: true });
        expect(resolveAccountDisplayName({ profile: UNNAMED, accountId: 'someone-else', viewerAccountId: 'me' }).name)
            .toBe('accountDisplay.unnamed');
    });
});

describe('resolveViewerAccountDisplayName', () => {
    it('names the viewer\'s own Account by its name, else "Your account" (never an id or "Unnamed")', () => {
        expect(resolveViewerAccountDisplayName(' Leeroy Brun ')).toBe('Leeroy Brun');
        expect(resolveViewerAccountDisplayName(null)).toBe('accountDisplay.yours');
        expect(resolveViewerAccountDisplayName('  ')).toBe('accountDisplay.yours');
    });
});
