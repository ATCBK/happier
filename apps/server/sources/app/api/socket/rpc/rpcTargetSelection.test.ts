import { describe, expect, it, vi } from "vitest";

import { selectRpcTarget } from "./rpcTargetSelection";

function createCandidate(id: string) {
    return {
        id,
        timeout: vi.fn(),
    };
}

describe("selectRpcTarget", () => {
    it('selects only the exact answering client and never substitutes a disconnected selection', () => {
        const first = createCandidate('client-a');
        const selected = createCandidate('client-b');
        expect(selectRpcTarget({ targets: [first, selected], answeringClient: { clientId: selected.id } }))
            .toMatchObject({ type: 'target', target: selected });
        expect(selectRpcTarget({ targets: [first], answeringClient: { clientId: selected.id } }))
            .toEqual({ type: 'not-available' });
    });

    it('refuses ambiguous mutations while preserving unselected reads and sole eligible clients', () => {
        const first = createCandidate('client-a');
        const second = createCandidate('client-b');
        expect(selectRpcTarget({ targets: [first, second], answeringClient: { requireSingle: true } }))
            .toEqual({ type: 'ambiguous', clientIds: ['client-a', 'client-b'] });
        expect(selectRpcTarget({ targets: [first, second] })).toMatchObject({ type: 'target', target: first });
        expect(selectRpcTarget({ targets: [first, second], excludedSocketId: first.id, answeringClient: { requireSingle: true } }))
            .toMatchObject({ type: 'target', target: second });
    });
    it("rejects a self-call when the caller is the only available target", () => {
        expect(selectRpcTarget({
            targets: [createCandidate("caller-socket")],
            excludedSocketId: "caller-socket",
        })).toEqual({
            type: "self-call",
        });
    });

    it("chooses a non-caller target when both the caller and another socket are present", () => {
        const caller = createCandidate("caller-socket");
        const target = createCandidate("target-socket");

        expect(selectRpcTarget({
            targets: [caller, target],
            excludedSocketId: "caller-socket",
        })).toEqual({
            type: "target",
            target,
            hadMultipleTargets: true,
        });
    });

    it("chooses deterministically when more than one non-caller target is present", () => {
        const targetB = createCandidate("target-b");
        const targetA = createCandidate("target-a");

        expect(selectRpcTarget({
            targets: [targetB, targetA],
        })).toEqual({
            type: "target",
            target: targetA,
            hadMultipleTargets: true,
        });
    });
});
