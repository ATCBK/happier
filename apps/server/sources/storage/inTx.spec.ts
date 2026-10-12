import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClientKnownRequestError, PrismaClientUnknownRequestError } from "@prisma/client/runtime/library";

import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { installDbModuleMock } from "../app/api/testkit/dbMocks";

const transaction = vi.fn(async (fn: any, _opts?: any) => fn({} as any));
const delayMock = vi.fn(async () => {});
const recordDatabaseTransactionRetry = vi.fn();

installDbModuleMock({
    db: {
        $transaction: transaction,
    },
});

const logMock = vi.fn();

vi.mock("@/utils/runtime/delay", () => ({ delay: delayMock }));
vi.mock("@/utils/logging/log", () => ({ log: (...args: any[]) => logMock(...args) }));
vi.mock("@/app/monitoring/metrics/sessionWriteMetrics", () => ({
    recordDatabaseTransactionRetry: (...args: any[]) => recordDatabaseTransactionRetry(...args),
}));

// `installDbModuleMock` uses `vi.doMock`, which is not hoisted, so `./inTx`
// has to load after the mocks above — but it must not load inside a case
// either. Paying the file's first transform inside a case's 20 s test budget
// is what made the first case time out under host load and leave its still
// running `inTx` to land an extra `$transaction` call in the next case. The
// module reads the environment per call (`inTx.ts:115-116`), so one load here,
// during collection, serves every case.
const inTxModule = await import("./inTx");
const { inTx, afterTx } = inTxModule;

describe("inTx", () => {
    const envSnapshot = snapshotEnv();

    afterEach(() => {
        vi.restoreAllMocks();
        restoreEnv(envSnapshot);
        transaction.mockReset();
        transaction.mockImplementation(async (fn: any, _opts?: any) => fn({} as any));
        delayMock.mockClear();
        logMock.mockClear();
        recordDatabaseTransactionRetry.mockClear();
    });

    it("reports a failed after-commit callback instead of discarding it", async () => {
        const later = vi.fn();
        const failure = new Error("eviction publication failed");

        await expect(inTx(async (tx) => {
            afterTx(tx, () => { throw failure; });
            afterTx(tx, later);
            return "committed";
        })).resolves.toBe("committed");

        // The commit stands and later callbacks still run, but the failure is
        // observable rather than swallowed.
        expect(later).toHaveBeenCalledTimes(1);
        expect(logMock).toHaveBeenCalledWith(
            expect.objectContaining({ module: "storage-tx" }),
            expect.stringContaining("after-commit callback failed"),
            failure,
        );
    });

    it("uses read-committed transactions by default", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const result = await inTx(async () => 123);

        expect(result).toBe(123);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(expect.objectContaining({ isolationLevel: "ReadCommitted" }));
    });

    it("passes configured transaction timeout options without isolationLevel on SQLite", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TIMEOUT_MS: "12000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "7000",
        });

        const result = await inTx(async () => 456);

        expect(result).toBe(456);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]!.length).toBe(2);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({
                maxWait: 7000,
                timeout: 12000,
            }),
        );
        expect(transaction.mock.calls[0]![1]).not.toEqual(
            expect.objectContaining({ isolationLevel: expect.anything() }),
        );
    });

    it("preserves explicit serializable isolation for cross-row invariants", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });

        const result = await inTx(async () => 321, { isolationLevel: "Serializable" });

        expect(result).toBe(321);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transaction.mock.calls[0]![1]).toEqual(
            expect.objectContaining({ isolationLevel: "Serializable" }),
        );
    });

    it("caps transaction acquisition and execution inside an absolute request deadline", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
        });
        vi.spyOn(Date, "now").mockReturnValue(1_000);

        await expect(inTx(async () => 123, { deadlineAtMs: 10_000 })).resolves.toBe(123);

        expect(transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
            maxWait: expect.any(Number),
            timeout: expect.any(Number),
        }));
        const options = transaction.mock.calls[0]![1] as { maxWait: number; timeout: number };
        expect(options.maxWait + options.timeout).toBeLessThanOrEqual(9_000);
    });

    it("retries P2034 and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const result = await inTx(async () => 789);

        expect(result).toBe(789);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("postgres");
    });

    it.each([
        new PrismaClientKnownRequestError(
            'Raw query failed. Code: `40001`. Message: `could not serialize access due to read/write dependencies among transactions`',
            { code: "P2010", clientVersion: "6.19.2", meta: { code: "40001", message: "could not serialize access due to read/write dependencies among transactions" } },
        ),
        new PrismaClientUnknownRequestError(
            'Invalid `prisma.session.update()` invocation: PostgresError { code: "40P01", message: "deadlock detected" }',
            { clientVersion: "6.19.2" },
        ),
        ...["40001", "40P01"].map(code => new PrismaClientKnownRequestError(
            `Raw query failed. Code: \`${code}\`. Message: \`transaction conflict\``,
            { code: "P2010", clientVersion: "6.19.2", meta: { code, message: "transaction conflict" } },
        )),
    ])("replays PostgreSQL conflicts without publishing rolled-back afterTx effects: %s", async (failure) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        let attempts = 0;
        const published: number[] = [];

        await expect(inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            if (attempt === 1) throw failure;
            return "committed";
        })).resolves.toBe("committed");

        expect(attempts).toBe(2);
        expect(published).toEqual([2]);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("preserves the retry budget and exposes one typed PostgreSQL conflict after exhaustion", async () => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const failure = new PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010", clientVersion: "6.19.2", meta: { code: "40001" },
        });
        let attempts = 0;
        const published = vi.fn();
        await expect(inTx(async tx => {
            attempts++;
            afterTx(tx, published);
            throw failure;
        })).rejects.toMatchObject({
            name: "TransactionConflictExhaustedError",
            code: "database_transaction_conflict_exhausted",
            cause: failure,
        });
        expect(attempts).toBe(2);
        expect(published).not.toHaveBeenCalled();
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("replays audience acquisition under the existing retry budget (exhausted: %s)", async (exhausted) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        let attempts = 0;
        const published: number[] = [];
        const operation = inTx(async tx => {
            const attempt = ++attempts;
            afterTx(tx, () => published.push(attempt));
            if (exhausted || attempt === 1) throw new inTxModule.TransactionReplayRequiredError("session-account-audience-changed");
            return "committed";
        });

        if (exhausted) {
            await expect(operation).rejects.toMatchObject({
                name: "TransactionConflictExhaustedError", code: "database_transaction_conflict_exhausted",
            });
            expect(published).toEqual([]);
        } else {
            await expect(operation).resolves.toBe("committed");
            expect(published).toEqual([2]);
        }
        expect(attempts).toBe(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        { meta: { code: "40001", modelName: "Session" }, failedStatementRelation: "Session" },
        { meta: { code: "40001" }, failedStatementRelation: undefined },
    ])("reports rollback transaction class and only driver-provided relation metadata (%j)", async ({ meta, failedStatementRelation }) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const failure = new PrismaClientKnownRequestError("private query contents", {
            code: "P2010", clientVersion: "6.19.2", meta,
        });
        await expect(inTx(async () => { throw failure; }, { transactionClass: "pending-input-admission" }))
            .rejects.toMatchObject({ code: "database_transaction_conflict_exhausted" });
        const diagnostic = logMock.mock.calls.find(([context]) => context.module === "storage-tx" && context.event === "transaction-rollback");
        expect(diagnostic).toBeDefined();
        expect(diagnostic![0]).toMatchObject({
            transactionClass: "pending-input-admission", provider: "postgres", sqlState: "40001", outcome: "conflict-exhausted",
        });
        expect(diagnostic![0].failedStatementRelation).toBe(failedStatementRelation);
        expect(diagnostic![0].conflictingRelation).toBeUndefined();
        expect(JSON.stringify(diagnostic)).not.toContain("private query contents");
    });

    it.each([
        { provider: "postgres", code: "42601" },
        { provider: "mysql", code: "40001" },
        { provider: "sqlite", code: "40P01" },
    ])("does not retry unrelated raw-query failures on $provider ($code)", async ({ provider, code }) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: provider });
        const failure = new PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010", clientVersion: "6.19.2", meta: { code },
        });
        const published = vi.fn();
        await expect(inTx(async tx => {
            afterTx(tx, published);
            throw failure;
        })).rejects.toBe(failure);
        expect(published).not.toHaveBeenCalled();
        expect(delayMock).not.toHaveBeenCalled();
    });

    it("retries repeated postgres P2034 conflicts until a later attempt succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
        });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("retry me 1"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 2"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 3"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 4"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 5"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 6"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 7"), { code: "P2034" }))
            .mockRejectedValueOnce(Object.assign(new Error("retry me 8"), { code: "P2034" }))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const result = await inTx(async () => 1337);

        expect(result).toBe(1337);
        expect(transaction).toHaveBeenCalledTimes(9);
        expect(delayMock).toHaveBeenCalledTimes(8);
        expect(delayMock.mock.calls).toEqual([[200], [400], [800], [1600], [3200], [5000], [5000], [5000]]);
    });

    it.each(["postgres", "mysql"])("retries transaction acquisition P2028 before the callback starts on %s", async (provider) => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: provider,
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction
            .mockRejectedValueOnce(acquisitionError)
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));
        const transactionBody = vi.fn(async () => 790);

        await expect(inTx(transactionBody)).resolves.toBe(790);

        expect(transaction).toHaveBeenCalledTimes(2);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("reports exhausted transaction acquisition as typed unavailability with the original cause", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
            HAPPIER_DB_TX_MAX_RETRIES: "0",
        });
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        transaction.mockRejectedValue(acquisitionError);
        const transactionBody = vi.fn(async () => 791);

        const rejection = await inTxModule.inTx(transactionBody).catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(inTxModule.TransactionAcquisitionUnavailableError);
        expect(rejection).toMatchObject({ code: "P2028", cause: acquisitionError });
        expect(transactionBody).not.toHaveBeenCalled();
    });

    it("does not classify an acquisition-shaped P2028 thrown after the callback starts as transaction acquisition", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: "postgres",
        });
        const operationError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const transactionBody = vi.fn(async () => {
            throw operationError;
        });

        await expect(inTx(transactionBody)).rejects.toBe(operationError);

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(transactionBody).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
    });

    it("retries raw postgres serialization aborts that are not wrapped as P2034", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: undefined,
        });
        transaction
            .mockRejectedValueOnce(new Error("could not serialize access due to read/write dependencies among transactions"))
            .mockImplementationOnce(async (fn: any, _opts?: any) => fn({} as any));

        const result = await inTx(async () => 4242);

        expect(result).toBe(4242);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("postgres");
    });

    it("retries sqlite P1008 socket timeout and eventually succeeds", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Socket timeout"), { code: "P1008" }))
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const result = await inTx(async () => 9001);

        expect(result).toBe(9001);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("retries sqlite P2024 connection pool timeouts and preserves retry metrics", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: "sqlite" });
        transaction
            .mockRejectedValueOnce(Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }))
            .mockImplementationOnce(async (fn: any) => fn({} as any));

        const result = await inTx(async () => 9002);

        expect(result).toBe(9002);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
        expect(recordDatabaseTransactionRetry).toHaveBeenCalledWith("sqlite");
    });

    it.each([
        { code: "P2034", message: "Transaction rolled back after a write conflict" },
        { code: "P2028", message: "Unable to start a transaction in the given time." },
    ])("does not claim definite no-effect after an earlier ambiguous SQLite attempt ($code)", async ({ code, message }) => {
        restoreEnv(envSnapshot);
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "sqlite", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const uncertainCompletion = Object.assign(new Error("SQLite completion socket timeout"), { code: "P1008" });
        // The first callback actually ran; its driver then loses the completion
        // result. A later rollback/acquisition failure cannot erase that fact.
        transaction
            .mockImplementationOnce(async fn => { await fn({}); throw uncertainCompletion; })
            .mockRejectedValueOnce(Object.assign(new Error(message), { code }));

        await expect(inTx(async () => "request-effect")).rejects.toBe(uncertainCompletion);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it("does not start a sqlite retry that would exceed the configured total retry budget", async () => {
        restoreEnv(envSnapshot);
        applyEnvValues({
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: "1",
            HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "100",
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
            HAPPIER_DB_TX_TIMEOUT_MS: "10000",
            HAPPIER_DB_TX_MAX_WAIT_MS: "5000",
        });
        const timeoutError = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        transaction
            .mockRejectedValueOnce(timeoutError)
            .mockImplementationOnce(async (fn: any) => fn({} as any));


        // A socket timeout is retryable by the existing SQLite owner but does
        // not establish rollback. Preserve its cause rather than claiming a
        // certain conflict refusal when the recovery budget is exhausted.
        await expect(inTx(async () => 9003)).rejects.toBe(timeoutError);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(delayMock).not.toHaveBeenCalled();
        expect(recordDatabaseTransactionRetry).not.toHaveBeenCalled();
    });

    it.each([false, true])("retains the typed SQLite deadline and earlier ambiguous cause (callback entered: %s)", async (callbackEntered) => {
        applyEnvValues({ HAPPY_DB_PROVIDER: undefined, HAPPIER_DB_PROVIDER: "sqlite", HAPPIER_DB_TX_MAX_RETRIES: "1" });
        const uncertainCompletion = Object.assign(new Error("Socket timeout"), { code: "P1008" });
        const finalFailure = Object.assign(new Error(callbackEntered ? "Transaction is already closed" : "Unable to start a transaction"), { code: "P2028" });
        transaction.mockRejectedValueOnce(uncertainCompletion);
        if (callbackEntered) {
            transaction.mockImplementationOnce(async fn => { await fn({}); throw finalFailure; });
        } else {
            transaction.mockRejectedValueOnce(finalFailure);
        }

        await expect(inTx(async () => "request-effect", { deadlineAtMs: Date.now() + 60_000 })).rejects.toMatchObject({
            name: "TransactionDeadlineExceededError", cause: uncertainCompletion,
        });
    });

    it.each([false, true])("does not certify rollback from PostgreSQL message heuristics (later conflict: %s)", async (laterConflict) => {
        applyEnvValues({ HAPPIER_DB_PROVIDER: "postgres", HAPPIER_DB_TX_MAX_RETRIES: laterConflict ? "1" : "0" });
        const uncertainCompletion = new Error("Connection lost while handling serialization failure");
        transaction.mockRejectedValueOnce(uncertainCompletion);
        if (laterConflict) transaction.mockRejectedValueOnce(Object.assign(new Error("Rolled back"), { code: "P2034" }));

        await expect(inTx(async () => "request-effect")).rejects.toBe(uncertainCompletion);
    });
});
