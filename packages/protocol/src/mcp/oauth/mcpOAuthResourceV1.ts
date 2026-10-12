import { McpRemoteUrlV1Schema } from '../remoteUrlV1.js';

/** The exact URL identity shared by sign-in, grant issuance and bridge requests. */
export function canonicalMcpOAuthResourceUrlV1(value: string): string {
    return new URL(McpRemoteUrlV1Schema.parse(value)).href;
}
