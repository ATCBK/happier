import { describe, expect, it, vi } from "vitest";

import type { ApiMachineClient } from "@/api/apiMachine";

import { attachPluginWebhookDaemonWakeV1 } from "./pluginWebhookDaemonWake";

describe("plugin webhook daemon wake", () => {
    it("nudges the existing single-flight claim worker on each machine-client webhook invalidation", async () => {
        // The machine client owns which Account changes invalidate webhook claims;
        // this wake only forwards that invalidation to the current worker.
        const listener = { current: null as (() => void | Promise<void>) | null };
        const unsubscribe = vi.fn();
        const onPluginWebhookInvalidated: Pick<ApiMachineClient, "onPluginWebhookInvalidated">["onPluginWebhookInvalidated"] = (next) => {
            listener.current = next;
            return unsubscribe;
        };
        const trigger = vi.fn();
        let worker: { trigger: typeof trigger } | null = null;
        const cleanup = attachPluginWebhookDaemonWakeV1({
            apiMachine: { onPluginWebhookInvalidated },
            getWorker: () => worker,
        });

        await listener.current?.();
        expect(trigger).not.toHaveBeenCalled();
        worker = { trigger };
        await listener.current?.();
        expect(trigger).toHaveBeenCalledTimes(1);

        cleanup();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
