import { createHash } from 'node:crypto';

/** Filesystem-safe Account namespace; independent of credentials and token rotation. */
export function managedAcpAccountNamespace(accountId: string): string {
  if (!accountId.trim()) throw new Error('Managed ACP installation requires an Account');
  return createHash('sha256').update(accountId).digest('hex');
}

function versionKey(definitionId: string, version: string): string {
  return createHash('sha256').update(JSON.stringify([definitionId, version])).digest('hex');
}

/** Both managed installers retain their existing trees, qualified by the same tuple. */
export function managedAcpInstallId(input: Readonly<{ accountId: string; definitionId: string; version: string }>): string {
  return `acp.${managedAcpAccountNamespace(input.accountId)}.${versionKey(input.definitionId, input.version)}`;
}

/** A receipt is authoritative only within the root matching its definition/version. */
export function readManagedAcpInstallNamespace(installId: string, definitionId: string, version: string): string | null {
  const match = /^acp\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(installId);
  return match?.[2] === versionKey(definitionId, version) ? match[1]! : null;
}
