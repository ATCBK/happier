import type { ProviderGatewayPlacementV1 } from '@happier-dev/protocol/providers/connections/v1';

/** Placement only: deployment eligibility and sharing policy are checked by
 * the caller against its admitted connection or retained runtime basis. */
export function isRemoteProviderGatewayPlacement(
  placement: ProviderGatewayPlacementV1 | undefined,
  machineId: string,
): placement is Extract<ProviderGatewayPlacementV1, { kind: 'machine' }> {
  return placement?.kind === 'machine' && placement.machineId !== machineId;
}
