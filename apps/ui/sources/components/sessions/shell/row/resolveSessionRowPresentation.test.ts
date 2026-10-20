import { describe, expect, it } from 'vitest';

type SessionRowAttentionState =
    | 'quiet'
    | 'mentioned'
    | 'unread'
    | 'pending'
    | 'working'
    | 'ready'
    | 'failed'
    | 'permission_required'
    | 'action_required';

type ResolveSessionRowPresentation = (input: Readonly<{
    attentionState: SessionRowAttentionState;
    density: 'default' | 'compact' | 'minimal';
    requestedSecondaryLineMode: 'status' | 'path';
    hasPathSubtitle: boolean;
    backgroundActive?: boolean;
    standing?: boolean;
}>) => Readonly<{
    attentionIndicator: 'none' | 'working' | 'ready' | 'failed' | 'unread' | 'pending' | 'permission' | 'action' | 'standing';
    titleTone: 'quiet' | 'normal' | 'emphasized';
    secondaryLine: 'none' | 'path' | 'status';
    statusTextKey?: 'status.readyForReview' | 'status.error' | 'status.backgroundActive' | 'status.keptInAttention';
    accessibilityStatusTextKey?:
        | 'status.readyForReview'
        | 'status.error'
        | 'status.backgroundActive'
        | 'status.keptInAttention'
        | 'status.unread'
        | 'status.mentioned'
        | 'status.queuedInput'
        | 'workStatus.buckets.needs_you';
}>;

async function loadRowPresentationResolver(): Promise<ResolveSessionRowPresentation> {
    const module = await import('./resolveSessionRowPresentation');
    const resolver = (module as Partial<{
        resolveSessionRowPresentation: ResolveSessionRowPresentation;
    }>).resolveSessionRowPresentation;
    expect(resolver).toBeTypeOf('function');
    return resolver as ResolveSessionRowPresentation;
}

describe('resolveSessionRowPresentation', () => {
    it('keeps minimal working rows to an indicator without a secondary line', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'working',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'none',
        });
    });

    it('uses a ready-for-review status subtitle for non-minimal ready rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'ready',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'ready',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.readyForReview',
            accessibilityStatusTextKey: 'status.readyForReview',
        });
    });

    it('uses an error status subtitle for non-minimal failed rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'failed',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.error',
            accessibilityStatusTextKey: 'status.error',
        });
    });

    it('lets background activity speak only for a row with nothing of its own to say', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'quiet',
            secondaryLine: 'status',
            statusTextKey: 'status.backgroundActive',
        });
        // An unread reply keeps its marker and is announced; the line still says work is running.
        expect(resolveSessionRowPresentation({
            attentionState: 'unread',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'unread',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.backgroundActive',
            accessibilityStatusTextKey: 'status.unread',
        });
        // A finished turn awaiting review is never disguised as work still running.
        expect(resolveSessionRowPresentation({
            attentionState: 'ready',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'ready',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.readyForReview',
            accessibilityStatusTextKey: 'status.readyForReview',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'pending',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'pending',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.backgroundActive',
            accessibilityStatusTextKey: 'status.queuedInput',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'permission_required',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'permission',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'action_required',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'action',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'failed',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.error',
            accessibilityStatusTextKey: 'status.error',
        });
    });

    it('uses the working spinner for background activity in minimal rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            backgroundActive: true,
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'quiet',
            secondaryLine: 'none',
        });
    });

    it('does not show online status text for quiet rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'none',
            titleTone: 'quiet',
            secondaryLine: 'none',
        });
    });
});

describe('session row attention standing presentation', () => {
    it('marks a kept but otherwise quiet row without emphasising its title', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
            standing: true,
        })).toEqual({
            attentionIndicator: 'standing',
            titleTone: 'quiet',
            secondaryLine: 'status',
            statusTextKey: 'status.keptInAttention',
            accessibilityStatusTextKey: 'status.keptInAttention',
        });
    });

    it('says a mention out loud instead of announcing the row as plain unread', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'mentioned',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            // The marker is shared with unread on purpose; the words are not.
            attentionIndicator: 'unread',
            titleTone: 'emphasized',
            secondaryLine: 'path',
            accessibilityStatusTextKey: 'status.mentioned',
        });
    });

    it('keeps the session own signal when it has one, so standing never masks unread or ready', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'unread',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
            standing: true,
        })).toEqual({
            attentionIndicator: 'unread',
            titleTone: 'emphasized',
            secondaryLine: 'path',
            accessibilityStatusTextKey: 'status.unread',
        });

        expect(resolveSessionRowPresentation({
            attentionState: 'ready',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
            standing: true,
        })).toMatchObject({
            attentionIndicator: 'ready',
            statusTextKey: 'status.readyForReview',
        });
    });

    it('still names a kept row on a minimal density row that draws no secondary line', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
            standing: true,
        })).toEqual({
            attentionIndicator: 'standing',
            titleTone: 'quiet',
            secondaryLine: 'none',
            statusTextKey: 'status.keptInAttention',
            accessibilityStatusTextKey: 'status.keptInAttention',
        });
    });
});
