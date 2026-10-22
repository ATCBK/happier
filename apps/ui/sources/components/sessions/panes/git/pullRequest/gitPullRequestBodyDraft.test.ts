import { describe, expect, it } from 'vitest';

import { resolveGitPullRequestBodyArrival } from './gitPullRequestBodyDraft';

describe('where a drafted pull request description lands', () => {
    it('fills a body nobody has touched since the request', () => {
        expect(resolveGitPullRequestBodyArrival({ bodyAtRequest: '', currentBody: '', candidate: 'Adds the form.' })).toBe('fill');
    });

    it('never overwrites text typed while the draft was being written', () => {
        expect(resolveGitPullRequestBodyArrival({ bodyAtRequest: '', currentBody: 'My own notes', candidate: 'Adds the form.' })).toBe('offer');
        expect(resolveGitPullRequestBodyArrival({ bodyAtRequest: 'Old', currentBody: 'Older, then edited', candidate: 'Adds the form.' })).toBe('offer');
    });

    it('offers rather than replaces a body the person had already written before asking', () => {
        expect(resolveGitPullRequestBodyArrival({ bodyAtRequest: 'Hand-written text', currentBody: 'Hand-written text', candidate: 'Adds the form.' })).toBe('offer');
    });

    it('has nothing to offer when the body already says the same', () => {
        expect(resolveGitPullRequestBodyArrival({ bodyAtRequest: '', currentBody: 'Adds the form.', candidate: 'Adds the form.' })).toBe('same');
    });
});
