/** Retained evidence/revisions keep their existing local access/currentness owner. */
export function isRetainedScmReviewAction(actionId: string, input: Readonly<Record<string, unknown>>): boolean {
    return actionId.startsWith('scm.diffSummary.result.')
        || actionId === 'scm.diffSummary.refine' || actionId === 'scm.diffSummary.addOutputs'
        || actionId === 'scm.diffSummary.discuss'
        || ((actionId === 'scm.diffSummary.reviewed.mark' || actionId === 'scm.diffSummary.reviewed.unmark')
            && !('changeKeys' in input));
}

/** Session placement replaces authored cwd with the admitted host workspace. */
export function bindScmActionToSessionWorkspace(actionId: string, input: Readonly<Record<string, unknown>>,
    workingDirectory: string, sessionId: string): Readonly<Record<string, unknown>> {
    return actionId === 'scm.repository.clone' ? input
        : actionId === 'scm.pullRequest.prepareWorktree' ? { ...input, cwd: workingDirectory, sourcePath: workingDirectory }
            : { ...input, cwd: workingDirectory, ...(actionId === 'scm.diffSummary.capture' ? { sessionId } : {}) };
}
