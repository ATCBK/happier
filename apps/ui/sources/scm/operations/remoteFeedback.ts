export type RemoteTargetDisplay = {
    remote: string;
    branch: string | null;
};

export type RemoteOperationKind = 'fetch' | 'pull' | 'push';

export function formatRemoteTargetForDisplay(target: RemoteTargetDisplay, detachedHeadLabel: string): string {
    if (target.branch) {
        return `${target.remote}/${target.branch}`;
    }
    return `${target.remote} (${detachedHeadLabel})`;
}

export function buildNonFastForwardFetchPromptDialog(input: {
    target: RemoteTargetDisplay;
    detachedHeadLabel: string;
}): {
    title: string;
    body: string;
    confirmText: 'Fetch';
    cancelText: 'Not now';
} {
    const displayTarget = formatRemoteTargetForDisplay(input.target, input.detachedHeadLabel);
    return {
        title: 'Remote has newer commits',
        body: [
            `Push to ${displayTarget} was rejected because the remote is ahead.`,
            'Fetch now to review and reconcile remote commits before pushing again.',
        ].join('\n'),
        confirmText: 'Fetch',
        cancelText: 'Not now',
    };
}

export function buildRemoteOperationBusyLabel(
    kind: RemoteOperationKind,
    target: RemoteTargetDisplay,
    detachedHeadLabel: string
): string {
    const displayTarget = formatRemoteTargetForDisplay(target, detachedHeadLabel);
    switch (kind) {
        case 'fetch':
            return `Fetching from ${displayTarget}…`;
        case 'pull':
            return `Pulling from ${displayTarget}…`;
        case 'push':
            return `Pushing to ${displayTarget}…`;
    }
}

function toSentenceCaseWord(kind: RemoteOperationKind): string {
    switch (kind) {
        case 'fetch':
            return 'Fetched';
        case 'pull':
            return 'Pulled';
        case 'push':
            return 'Pushed';
    }
}

function successPreposition(kind: RemoteOperationKind): 'from' | 'to' {
    return kind === 'push' ? 'to' : 'from';
}

function summarizeStdout(stdout: string): string | null {
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const firstLine = trimmed.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
    return firstLine ?? null;
}

export function buildRemoteOperationSuccessDetail(
    kind: RemoteOperationKind,
    target: RemoteTargetDisplay,
    stdout: string,
    detachedHeadLabel: string
): string {
    const displayTarget = formatRemoteTargetForDisplay(target, detachedHeadLabel);
    const base = `${toSentenceCaseWord(kind)} ${successPreposition(kind)} ${displayTarget}`;
    const summary = summarizeStdout(stdout);
    return summary ? `${base} • ${summary}` : base;
}
