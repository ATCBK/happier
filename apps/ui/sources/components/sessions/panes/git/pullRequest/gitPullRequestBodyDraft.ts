export type GitPullRequestBodyArrival = 'fill' | 'offer' | 'same';

/**
 * Where a drafted description lands in the new pull request form. It fills the body only when the person has
 * neither typed since asking nor had text there to lose; any other body is kept and the draft is offered beside
 * it, so asking for a draft never costs the person their own words.
 */
export function resolveGitPullRequestBodyArrival(input: Readonly<{
    bodyAtRequest: string;
    currentBody: string;
    candidate: string;
}>): GitPullRequestBodyArrival {
    if (input.currentBody === input.candidate) return 'same';
    if (input.currentBody !== input.bodyAtRequest) return 'offer';
    return input.currentBody.trim() === '' ? 'fill' : 'offer';
}
