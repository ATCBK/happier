/** Native dispatch may have committed input without a usable identity receipt. */
export class OpenCodePromptIdentityUnresolvedError extends Error {
  readonly code = 'opencode_prompt_identity_unresolved';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenCodePromptIdentityUnresolvedError';
  }
}
