import { PluginError } from '@happier-dev/plugin-sdk';

/** Host-proven startup refusal before any Session input can reach the Agent. */
export class SessionStartupInputRefusalError extends PluginError {
  constructor(input: Readonly<{ code: string; message: string }>) {
    super({ ...input, retryable: false });
  }
}
