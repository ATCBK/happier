/** Pure QA domain behavior shared by verified ingress and public invocation. */
export function summarizeNote(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !('text' in input)
        || typeof input.text !== 'string' || input.text.trim().length === 0) {
        throw new TypeError('A QA note requires one nonempty text field');
    }
    return { summary: input.text.trim() };
}
