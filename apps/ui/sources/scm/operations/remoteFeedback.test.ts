import { describe, expect, it } from 'vitest';

import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
    formatRemoteTargetForDisplay,
} from './remoteFeedback';

describe('formatRemoteTargetForDisplay', () => {
    it('formats remote with branch', () => {
        expect(formatRemoteTargetForDisplay({ remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe('origin/main');
    });

    it('falls back to detached label when branch is missing', () => {
        expect(formatRemoteTargetForDisplay({ remote: 'origin', branch: null }, 'Detached HEAD')).toBe('origin (Detached HEAD)');
    });
});

describe('buildRemoteOperationBusyLabel', () => {
    it('returns clear operation labels', () => {
        expect(buildRemoteOperationBusyLabel('fetch', { remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe(
            'Fetching from origin/main…'
        );
        expect(buildRemoteOperationBusyLabel('pull', { remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe(
            'Pulling from origin/main…'
        );
        expect(buildRemoteOperationBusyLabel('push', { remote: 'origin', branch: 'main' }, 'Detached HEAD')).toBe(
            'Pushing to origin/main…'
        );
    });
});

describe('buildRemoteOperationSuccessDetail', () => {
    it('returns friendly success details when stdout is empty', () => {
        expect(buildRemoteOperationSuccessDetail('fetch', { remote: 'origin', branch: 'main' }, '', 'Detached HEAD')).toBe(
            'Fetched from origin/main'
        );
    });

    it('prefers concise stdout summaries when available', () => {
        expect(
            buildRemoteOperationSuccessDetail(
                'push',
                { remote: 'origin', branch: 'main' },
                'Everything up-to-date\n',
                'Detached HEAD'
            )
        ).toBe('Pushed to origin/main • Everything up-to-date');
    });
});

describe('buildNonFastForwardFetchPromptDialog', () => {
    it('returns follow-up dialog copy for non-fast-forward push errors', () => {
        const dialog = buildNonFastForwardFetchPromptDialog({
            target: { remote: 'origin', branch: 'main' },
            detachedHeadLabel: 'Detached HEAD',
        });

        expect(dialog.title).toBe('Remote has newer commits');
        expect(dialog.body).toContain('Push to origin/main was rejected');
        expect(dialog.confirmText).toBe('Fetch');
        expect(dialog.cancelText).toBe('Not now');
    });
});
