import { join } from 'node:path';

import { ConnectedServiceAuthGroupIdSchema, ConnectedServiceIdSchema, ConnectedServiceProfileIdSchema, type ConnectedAccountServiceKey } from '@happier-dev/protocol';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from '@happier-dev/protocol/connect/connected-service-bindings';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';

type JoinPath = (...paths: string[]) => string;

const CONNECTED_SERVICE_GROUPS_HOME_SEGMENT = '__groups';

function serviceHomeSegment(serviceId: ConnectedAccountServiceKey): string {
  const qualified = parseQualifiedPluginContributionKey(serviceId);
  if (!qualified) return ConnectedServiceIdSchema.parse(serviceId);
  return readBuiltInLegacyConnectedServiceIdForQualifiedService(qualified)
    ?? `qualified-${normalizeMaterializationKeyForPath(serviceId)}`;
}

export function resolveConnectedServiceHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
  pathJoin?: JoinPath;
}>): string {
  const pathJoin = params.pathJoin ?? join;
  const base = pathJoin(
    params.activeServerDir,
    'daemon',
    'connected-services',
    'homes',
    serviceHomeSegment(params.serviceId),
    ConnectedServiceProfileIdSchema.safeParse(params.profileId).success
      ? params.profileId : normalizeMaterializationKeyForPath(params.profileId),
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}

export function resolveConnectedServiceGroupHomeDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  agentId: CatalogAgentId;
  providerScopedKey?: string | null;
  pathJoin?: JoinPath;
}>): string {
  const pathJoin = params.pathJoin ?? join;
  const base = pathJoin(
    params.activeServerDir,
    'daemon',
    'connected-services',
    'homes',
    serviceHomeSegment(params.serviceId),
    CONNECTED_SERVICE_GROUPS_HOME_SEGMENT,
    ConnectedServiceAuthGroupIdSchema.safeParse(params.groupId).success
      ? params.groupId : normalizeMaterializationKeyForPath(params.groupId),
    params.agentId,
  );
  const providerScopedKey = typeof params.providerScopedKey === 'string' ? params.providerScopedKey.trim() : '';
  if (!providerScopedKey) return base;
  return pathJoin(base, normalizeMaterializationKeyForPath(providerScopedKey));
}
