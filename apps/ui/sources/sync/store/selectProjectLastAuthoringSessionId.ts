import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
    EMPTY_PROJECT_AUTHORING_SESSION_INPUTS,
    projectAuthoringCheckoutKey,
    type ProjectAuthoringSessionInputs,
} from './domains/projectAuthoringSessions';
import type { StorageState } from './types';

const latestByInputs = new WeakMap<ProjectAuthoringSessionInputs, ReadonlyMap<string, ProjectAuthoringSessionInputs[string]>>();

/** The latest Session started from setup authoring for this exact checkout, as one primitive key. */
export function selectProjectLastAuthoringSessionId(
    state: Pick<StorageState, 'projectAuthoringSessions'>,
    workspace: WorkspaceAddressV1,
    accountId: string | null,
): string | null {
    if (!accountId) return null;
    const checkoutKey = projectAuthoringCheckoutKey(workspace, accountId);
    if (!checkoutKey) return null;
    const inputs = state.projectAuthoringSessions ?? EMPTY_PROJECT_AUTHORING_SESSION_INPUTS;
    let latest = latestByInputs.get(inputs);
    if (!latest) {
        const candidates = new Map<string, ProjectAuthoringSessionInputs[string]>();
        for (const input of Object.values(inputs)) {
            const previous = candidates.get(input.checkoutKey);
            if (!previous || input.updatedAt > previous.updatedAt) candidates.set(input.checkoutKey, input);
        }
        latest = candidates;
        latestByInputs.set(inputs, latest);
    }
    return latest.get(checkoutKey)?.sessionId ?? null;
}
