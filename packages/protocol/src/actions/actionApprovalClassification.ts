import type { ActionId } from "./actionIds.js";
import type { ActionApproval } from "./actionApprovalMetadata.js";
import { getActionSpec } from "./actionSpecs.js";

/** The Action declaration owns result custody and approval flow. */
export function resolveApprovalMetadataForActionId(actionId: ActionId): ActionApproval {
  return getActionSpec(actionId).approval;
}
