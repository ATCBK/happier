import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from "@/testkit/env";

// Sentry is an external telemetry boundary; process and shutdown internals stay real.
const sentry = vi.hoisted(() => ({
    captureException: vi.fn((_reason: unknown) => "event-id"),
    flush: vi.fn(async () => true),
}));
vi.mock("@sentry/node", () => ({
    getClient: () => ({}),
    captureException: sentry.captureException,
    flush: sentry.flush,
}));

const processHandlerEnvKeys = ["NODE_ENV", "HAPPY_EXIT_ON_FATAL", "HAPPIER_SERVER_LOG_LEVEL"] as const;
const processEvents = ["uncaughtException", "unhandledRejection", "warning", "exit", "SIGINT", "SIGTERM"] as const;
type ProcessEvent = typeof processEvents[number];
// Snapshot heterogeneous process events through their shared, real EventEmitter boundary.
const processEmitter: EventEmitter = process;
const installedFlag = "__HAPPY_PROCESS_HANDLERS_INSTALLED";

describe("registerProcessHandlers", () => {
    let listenersBefore: Map<ProcessEvent, ReturnType<typeof processEmitter.listeners>>;
    let installedFlagBefore: PropertyDescriptor | undefined;
    let envBefore: ReturnType<typeof snapshotEnvValues>;
    let exitCodeBefore: typeof process.exitCode;

    function ownedListeners(event: ProcessEvent) {
        const before = listenersBefore.get(event) ?? [];
        return processEmitter.listeners(event).filter((listener) => !before.includes(listener));
    }

    function invokeFatal(event: "uncaughtException" | "unhandledRejection", ...args: unknown[]) {
        const listeners = ownedListeners(event);
        expect(listeners).toHaveLength(1);
        // Emit only to our listener: Vitest owns its own fatal-process observers.
        Reflect.apply(listeners[0], process, args);
    }

    async function loadRegisteredHandlers() {
        const shutdown = await import("./shutdown");
        const { registerProcessHandlers } = await import("./processHandlers");
        registerProcessHandlers();
        return { ...shutdown, registerProcessHandlers };
    }

    beforeEach(() => {
        vi.resetModules();
        sentry.captureException.mockReset().mockReturnValue("event-id");
        sentry.flush.mockReset().mockResolvedValue(true);
        listenersBefore = new Map(processEvents.map((event) => [event, processEmitter.listeners(event)]));
        installedFlagBefore = Object.getOwnPropertyDescriptor(globalThis, installedFlag);
        Reflect.deleteProperty(globalThis, installedFlag);
        exitCodeBefore = process.exitCode;
        envBefore = snapshotEnvValues(processHandlerEnvKeys);
        applyEnvValues({ NODE_ENV: "test", HAPPY_EXIT_ON_FATAL: undefined, HAPPIER_SERVER_LOG_LEVEL: "silent" });
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        for (const event of processEvents) {
            for (const listener of ownedListeners(event)) {
                // Node exposes stored listeners as Function[], but EventEmitter only stores callables.
                processEmitter.off(event, listener as (...args: unknown[]) => void);
            }
            expect(processEmitter.listeners(event)).toEqual(listenersBefore.get(event));
        }
        if (installedFlagBefore) {
            Object.defineProperty(globalThis, installedFlag, installedFlagBefore);
        } else {
            Reflect.deleteProperty(globalThis, installedFlag);
        }
        process.exitCode = exitCodeBefore;
        restoreEnvValues(envBefore);
        vi.restoreAllMocks();
    });

    it("finishes real shutdown hooks and releases signal listeners before exiting on an uncaught exception", async () => {
        applyEnvValues({ NODE_ENV: "production", HAPPY_EXIT_ON_FATAL: "1" });
        const order: string[] = [];
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            order.push("exit");
            return undefined as never;
        });
        const { awaitShutdown, onShutdown, shutdownSignal } = await loadRegisteredHandlers();
        let releaseHook!: () => void;
        const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
        onShutdown("resource", async () => {
            order.push("hook:start");
            await hookGate;
            order.push("hook:done");
        });
        const shutdown = awaitShutdown();
        expect(ownedListeners("SIGINT")).toHaveLength(1);
        expect(ownedListeners("SIGTERM")).toHaveLength(1);

        const error = new Error("boom");
        try {
            invokeFatal("uncaughtException", error);
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(sentry.captureException).toHaveBeenCalledWith(error);
            expect(sentry.flush).toHaveBeenCalled();
            expect(shutdownSignal.aborted).toBe(true);
            expect(process.exitCode).toBe(1);
            expect(order).toEqual(["hook:start"]);
            expect(exitSpy).not.toHaveBeenCalled();
            expect(ownedListeners("SIGINT")).toEqual([]);
            expect(ownedListeners("SIGTERM")).toEqual([]);
        } finally {
            releaseHook();
            if (shutdownSignal.aborted) {
                await shutdown;
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }
        expect(order).toEqual(["hook:start", "hook:done", "exit"]);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("runs real cleanup for an unhandled rejection without hard-exiting in test mode", async () => {
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
        const { awaitShutdown, onShutdown, isShutdown, registerProcessHandlers } = await loadRegisteredHandlers();
        registerProcessHandlers();
        let cleanedUp = false;
        onShutdown("resource", async () => { cleanedUp = true; });
        const shutdown = awaitShutdown();

        invokeFatal("unhandledRejection", "nope", Promise.resolve());
        await shutdown;
        await new Promise<void>((resolve) => setImmediate(resolve));

        const capturedError = sentry.captureException.mock.calls[0]?.[0];
        expect(capturedError).toBeInstanceOf(Error);
        expect(capturedError).toMatchObject({ message: "nope" });
        expect(sentry.flush).toHaveBeenCalled();
        expect(cleanedUp).toBe(true);
        expect(isShutdown()).toBe(true);
        expect(process.exitCode).toBe(1);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(ownedListeners("SIGINT")).toEqual([]);
        expect(ownedListeners("SIGTERM")).toEqual([]);
    });

    it.each(["captureException", "flush"] as const)("still cleans up and exits when Sentry %s fails", async (failure) => {
        applyEnvValues({ NODE_ENV: "production", HAPPY_EXIT_ON_FATAL: "1" });
        if (failure === "captureException") {
            sentry.captureException.mockImplementationOnce(() => { throw new Error("telemetry unavailable"); });
        } else {
            sentry.flush.mockRejectedValueOnce(new Error("telemetry unavailable"));
        }
        let cleanedUp = false;
        const cleanupAtExit: boolean[] = [];
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            cleanupAtExit.push(cleanedUp);
            return undefined as never;
        });
        const { awaitShutdown, onShutdown, isShutdown } = await loadRegisteredHandlers();
        onShutdown("resource", async () => { cleanedUp = true; });
        const shutdown = awaitShutdown();

        invokeFatal("uncaughtException", new Error("fatal"));
        await shutdown;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(cleanedUp).toBe(true);
        expect(isShutdown()).toBe(true);
        expect(process.exitCode).toBe(1);
        expect(cleanupAtExit).toEqual([true]);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
