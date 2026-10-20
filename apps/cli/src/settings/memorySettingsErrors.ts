export class MemorySettingsSecretsUnavailableError extends Error {
  readonly code = 'memory_settings_secrets_unavailable';
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? `memory_settings_secrets_unavailable: ${cause.message}`
        : 'memory_settings_secrets_unavailable',
    );
    this.name = 'MemorySettingsSecretsUnavailableError';
    this.cause = cause;
  }
}
