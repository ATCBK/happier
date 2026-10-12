import { readDatabaseTransactionConfigFromEnv, resolveTransactionRetryDelayMs, type DatabaseTransactionConfig } from "@/config/databaseTransactions";
import { recordDatabaseTransactionRetry } from "@/app/monitoring/metrics/sessionWriteMetrics";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, prismaRuntime, withSqliteReadSnapshot, type TransactionClient } from "@/storage/prisma";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { log } from "@/utils/logging/log";

export type Tx = TransactionClient;
export type InTxOptions = Readonly<{
    readOnly?: boolean;
    isolationLevel?: "Serializable" | "ReadCommitted";
    timeoutMs?: number;
    maxWaitMs?: number;
    deadlineAtMs?: number;
    transactionClass?: string;
}>;

export type TransactionReplayReason = "session-account-audience-changed"
    | "pending-activation-target-changed"
    | "transaction-account-audience-changed";

/** Abort the current transaction when its fenced audience no longer matches its reads. */
export class TransactionReplayRequiredError extends Error {
    constructor(readonly reason: TransactionReplayReason) {
        super("Database transaction must replay its current account audience");
        this.name = "TransactionReplayRequiredError";
    }
}

/** Recovery exhausted after the transaction owner established rollback. */
export class TransactionConflictExhaustedError extends Error {
    readonly code = "database_transaction_conflict_exhausted";

    constructor(readonly cause: unknown) {
        super("Database transaction conflict recovery is exhausted");
        this.name = "TransactionConflictExhaustedError";
    }
}

export function isTransactionConflictExhaustedError(error: unknown): error is TransactionConflictExhaustedError {
    return error instanceof TransactionConflictExhaustedError;
}

export class TransactionAcquisitionUnavailableError extends Error {
    readonly code = "P2028";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction acquisition is temporarily unavailable");
        this.name = "TransactionAcquisitionUnavailableError";
        this.cause = cause;
    }
}

export class TransactionDeadlineExceededError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction request deadline expired");
        this.name = "TransactionDeadlineExceededError";
        this.cause = cause;
    }
}

export function isTransactionDeadlineExceededError(error: unknown): error is TransactionDeadlineExceededError {
    return error instanceof TransactionDeadlineExceededError;
}

const symbol = Symbol();

function errorMessage(err: unknown): string {
    if (err instanceof Error && typeof err.message === "string") return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const value = (err as { message?: unknown }).message;
        if (typeof value === "string") return value;
    }
    return "";
}

function readPostgresConflictSqlState(error: unknown): "40001" | "40P01" | undefined {
    if (isPrismaErrorCode(error, "40001")) return "40001";
    if (isPrismaErrorCode(error, "40P01")) return "40P01";
    // Raw queries preserve the server SQLSTATE in Prisma P2010 metadata.
    if (isPrismaErrorCode(error, "P2010") && typeof error === "object" && error !== null && "meta" in error) {
        const meta = error.meta;
        if (meta && typeof meta === "object" && "code" in meta
            && (meta.code === "40001" || meta.code === "40P01")) return meta.code;
    }
    // Prisma's unknown-request wrapper exposes the native PostgresError code
    // in its driver diagnostic. Arbitrary application messages are not proof.
    if (error instanceof prismaRuntime.PrismaClientUnknownRequestError) {
        const code = /\bPostgresError\s*\{\s*code:\s*"(40001|40P01)"/.exec(error.message)?.[1];
        if (code === "40001" || code === "40P01") return code;
    }
    return undefined;
}

export function isRetryableTransactionError(params: Readonly<{ provider: string; err: unknown }>): boolean {
    // Acquisition-shaped P2028 requires callback-entry context, which only inTx owns.
    if (isTransactionAcquisitionTimeout(params.err)) return false;
    if (isPrismaErrorCode(params.err, "P2034")) return true;

    if (params.provider === "postgres") {
        if (readPostgresConflictSqlState(params.err)) return true;
        // Retain historical recovery heuristics without treating them as
        // confirmed rollback when recovery ultimately fails.
        const message = errorMessage(params.err).toLowerCase();
        if (message.includes("could not serialize access")) return true;
        if (message.includes("serialization failure")) return true;
        if (message.includes("deadlock detected")) return true;
    }

    if (params.provider === "sqlite") {
        if (isRetryableSqliteWriteError(params.err)) return true;
    }

    return false;
}

function readTransactionErrorMessage(error: unknown): string {
    if (error && typeof error === "object" && "meta" in error) {
        const metaError = (error as { meta?: { error?: unknown } }).meta?.error;
        if (typeof metaError === "string") return metaError;
    }
    return errorMessage(error);
}

export function isTransactionAcquisitionTimeout(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2028")
        && readTransactionErrorMessage(error).toLowerCase().includes("unable to start a transaction");
}

export function isTransactionAcquisitionUnavailableError(
    error: unknown,
): error is TransactionAcquisitionUnavailableError {
    return error instanceof TransactionAcquisitionUnavailableError;
}

export function afterTx(tx: Tx, callback: () => void) {
    // Golden rule:
    // - Do NOT emit socket updates inside a DB transaction.
    // - Instead, schedule them with afterTx so they only fire after commit.
    //
    // `afterTx` is only valid for transactions created via `inTx()`.
    const callbacks = (tx as any)[symbol] as (() => void)[] | undefined;
    if (!callbacks) {
        throw new Error('afterTx(tx, ...) called outside inTx() transaction');
    }
    callbacks.push(callback);
}

function canStartAnotherSqliteTransactionAttempt(params: Readonly<{
    config: DatabaseTransactionConfig;
    retryDelayMs: number;
    startedAtMs: number;
}>): boolean {
    const elapsedMs = Date.now() - params.startedAtMs;
    const nextAttemptBudgetMs = params.config.maxWaitMs + params.config.timeoutMs;
    return elapsedMs + params.retryDelayMs + nextAttemptBudgetMs <= params.config.totalRetryBudgetMs;
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>, options?: InTxOptions): Promise<T> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider === "sqlite" && options?.readOnly) {
        return await withSqliteReadSnapshot(fn, { deadlineAtMs: options.deadlineAtMs });
    }
    const transactionConfig = readDatabaseTransactionConfigFromEnv(process.env, provider);
    let counter = 0;
    const startedAtMs = Date.now();
    let ambiguousAttemptFailure: { error: unknown } | undefined;
    let transactionCallbackEntered = false;
    let wrapped = async (tx: Tx) => {
        transactionCallbackEntered = true;
        if (
            options?.deadlineAtMs !== undefined
            && Date.now() >= options.deadlineAtMs
        ) {
            throw new TransactionDeadlineExceededError(null);
        }
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        transactionCallbackEntered = false;
        try {
            const remainingMs = options?.deadlineAtMs === undefined
                ? null
                : Math.floor(options.deadlineAtMs - Date.now());
            if (remainingMs !== null && remainingMs < 2) {
                throw new TransactionDeadlineExceededError(null);
            }
            const configuredMaxWaitMs = options?.maxWaitMs ?? transactionConfig.maxWaitMs;
            const configuredTimeoutMs = options?.timeoutMs ?? transactionConfig.timeoutMs;
            const boundedMaxWaitMs = remainingMs === null
                ? configuredMaxWaitMs
                : Math.max(1, Math.min(configuredMaxWaitMs, Math.floor(remainingMs / 3)));
            const boundedTimeoutMs = remainingMs === null
                ? configuredTimeoutMs
                : Math.max(1, Math.min(configuredTimeoutMs, remainingMs - boundedMaxWaitMs));
            const txOpts =
                provider === "sqlite"
                    ? {
                          timeout: boundedTimeoutMs,
                          maxWait: boundedMaxWaitMs,
                      }
                    : {
                          isolationLevel: options?.isolationLevel ?? "Serializable",
                          timeout: boundedTimeoutMs,
                          maxWait: boundedMaxWaitMs,
                      };
            let result = await db.$transaction(wrapped, txOpts);
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch (callbackError) {
                    // The committed result stands, so a failed after-commit
                    // callback never fails the transaction. It is still the
                    // only signal that a post-commit consequence — a socket
                    // eviction, an alert, a projection refresh — did not run,
                    // so it is reported rather than discarded.
                    log(
                        { module: "storage-tx", level: "error" },
                        "after-commit callback failed",
                        callbackError,
                    );
                }
            }
            return result.result;
        } catch (e) {
            const acquisitionTimeout = isTransactionAcquisitionTimeout(e) && !transactionCallbackEntered;
            const sqlState = provider === "postgres" ? readPostgresConflictSqlState(e) : undefined;
            const retryable = acquisitionTimeout
                || (transactionCallbackEntered && e instanceof TransactionReplayRequiredError)
                || isRetryableTransactionError({ provider, err: e });
            const confirmedRollback = (transactionCallbackEntered && e instanceof TransactionReplayRequiredError)
                || isPrismaErrorCode(e, "P2034")
                || sqlState !== undefined;
            // Retryable transport failures and legacy message heuristics do
            // not prove an earlier attempt failed to commit. Later rollback or
            // acquisition failure cannot erase that unknown outcome.
            if (retryable && !acquisitionTimeout && !confirmedRollback) {
                ambiguousAttemptFailure ??= { error: e };
            }
            const throwExhausted = (): never => {
                if (isTransactionDeadlineExceededError(e)) {
                    throw ambiguousAttemptFailure ? new TransactionDeadlineExceededError(ambiguousAttemptFailure.error) : e;
                }
                if (acquisitionTimeout && options?.deadlineAtMs !== undefined) {
                    throw new TransactionDeadlineExceededError(ambiguousAttemptFailure?.error ?? e);
                }
                if (ambiguousAttemptFailure) throw ambiguousAttemptFailure.error;
                if (acquisitionTimeout) {
                    throw new TransactionAcquisitionUnavailableError(e);
                }
                if (confirmedRollback) {
                    const meta = typeof e === "object" && e !== null && "meta" in e ? e.meta : undefined;
                    const failedStatementRelation = typeof meta === "object" && meta !== null
                        && "modelName" in meta && typeof meta.modelName === "string" ? meta.modelName : undefined;
                    log({
                        module: "storage-tx", level: "warn", event: "transaction-rollback",
                        transactionClass: options?.transactionClass ?? "unspecified",
                        provider, sqlState, failedStatementRelation, outcome: "conflict-exhausted",
                        attempts: counter + 1,
                        ...(e instanceof TransactionReplayRequiredError ? { replayReason: e.reason } : {}),
                    }, "Database transaction rollback recovery exhausted");
                    throw new TransactionConflictExhaustedError(e);
                }
                throw e;
            };
            if (
                options?.deadlineAtMs !== undefined
                && transactionCallbackEntered
                && (Date.now() >= options.deadlineAtMs || isPrismaErrorCode(e, "P2028"))
            ) {
                throw new TransactionDeadlineExceededError(ambiguousAttemptFailure?.error ?? e);
            }
            if (retryable && counter < transactionConfig.maxRetries) {
                const nextAttempt = counter + 1;
                const retryDelayMs = resolveTransactionRetryDelayMs({
                    attempt: nextAttempt,
                    retryBaseDelayMs: transactionConfig.retryBaseDelayMs,
                    retryMaxDelayMs: transactionConfig.retryMaxDelayMs,
                    retryJitterFactor: transactionConfig.retryJitterFactor,
                });
                if (
                    provider === "sqlite" &&
                    !canStartAnotherSqliteTransactionAttempt({
                        config: transactionConfig,
                        retryDelayMs,
                        startedAtMs,
                    })
                ) {
                    throwExhausted();
                }
                if (options?.deadlineAtMs !== undefined && Date.now() + retryDelayMs >= options.deadlineAtMs) {
                    throw new TransactionDeadlineExceededError(ambiguousAttemptFailure?.error ?? e);
                }
                counter = nextAttempt;
                recordDatabaseTransactionRetry(provider);
                await delay(retryDelayMs);
                continue;
            }
            throwExhausted();
        }
    }
}
