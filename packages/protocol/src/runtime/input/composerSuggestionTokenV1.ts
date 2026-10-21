// Paths keep dots, slashes, backslashes, colons, dashes, underscores, tildes and hashes.
const TOKEN_DELIMITERS: ReadonlySet<string> = new Set([
  ',', ';', '(', ')', '[', ']', '{', '}', '<', '>', '!', '?', '"',
]);
const TOKEN_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\u00A0']);

export function isComposerTokenWhitespaceChar(char: string): boolean {
  return char.length === 0 || TOKEN_WHITESPACE.has(char);
}

export function isComposerTokenBoundaryChar(char: string): boolean {
  return isComposerTokenWhitespaceChar(char) || TOKEN_DELIMITERS.has(char);
}

/** Shared by suggestion insertion and the model-visible reference markers. */
export function formatComposerSuggestionToken(trigger: '@' | '$' | '/', value: string): string {
  return !value || Array.from(value).some(isComposerTokenBoundaryChar)
    ? `${trigger}"${value.replaceAll('"', '""')}"`
    : `${trigger}${value}`;
}
