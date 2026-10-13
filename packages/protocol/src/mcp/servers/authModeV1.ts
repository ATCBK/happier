import type { McpServerCatalogEntryV1 } from './settingsV1.js';
import { listValueRefSecretIdsV1, type ValueRefV1 } from '../../valueRefs/valueRefV1.js';

export type McpServerAuthModeV1 = 'none' | 'savedSecret' | 'machineEnv' | 'plainText';

function valueRefsFromServer(server: Pick<McpServerCatalogEntryV1, 'env' | 'remote'>): ValueRefV1[] {
  const refs = Object.values(server.env ?? {});
  const headerRefs = Object.values(server.remote?.headers ?? {});
  // Session facts assert origin; they are not an authentication credential.
  return [...refs, ...headerRefs].filter(valueRef => valueRef.t !== 'sessionAttested');
}

function isEnvironmentTemplateLiteral(value: string): boolean {
  return /\$\{[A-Z0-9_]+(?::[-=][^}]*)?\}/.test(value);
}

export function inferMcpServerAuthModeV1(server: Pick<McpServerCatalogEntryV1, 'env' | 'remote'>): McpServerAuthModeV1 {
  const refs = valueRefsFromServer(server);
  if (refs.length === 0) return 'none';

  if (refs.some((valueRef) => listValueRefSecretIdsV1(valueRef).length > 0)) {
    return 'savedSecret';
  }

  const literals = refs.filter((valueRef): valueRef is Extract<ValueRefV1, { t: 'literal' }> => valueRef?.t === 'literal');
  if (literals.length === refs.length && literals.every((valueRef) => isEnvironmentTemplateLiteral(valueRef.v))) {
    return 'machineEnv';
  }

  return 'plainText';
}
