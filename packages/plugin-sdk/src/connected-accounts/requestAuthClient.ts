/** @moduleRealm daemon */
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  buildConnectedAccountRequestAuthClientSource,
  type ConnectedAccountRequestAuthClient,
} from './requestAuth.js';

/** The callable host client executes exactly the transport emitted for child consumers. */
export async function createConnectedAccountRequestAuthClient(input: Readonly<{
  capabilityFile: string;
}>): Promise<ConnectedAccountRequestAuthClient> {
  const source = 'import { readFileSync } from "node:fs";\n'
    + buildConnectedAccountRequestAuthClientSource({
      capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
      capabilityPath: input.capabilityFile,
    })
    + '\nexport { lookupConnectedAccountRequestAuth, reportConnectedAccountAuthFailure, reportConnectedAccountQuotaFailure };';
  // The generated ESM boundary is untyped; its strict parsers validate every input and result.
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as ConnectedAccountRequestAuthClient;
}
