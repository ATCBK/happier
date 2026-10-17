import { inTx, type InTxOptions, type Tx } from "./inTx";
import { getDbProviderFromEnv } from "./prisma";

/** Keep content coherent, then let its policy owner readmit it after that snapshot closes. */
export async function readSnapshotWithCurrentAdmission<T, Capture = T>(
    read: ((tx: Tx) => Promise<T>) | Readonly<{
        capture: (tx: Tx) => Promise<Capture>;
        materialize: (captured: Capture) => Promise<T>;
    }>,
    readmit: (tx: Tx, captured: T) => Promise<T>,
): Promise<T> {
    // Protected locators may need slow private IO after the snapshot closes.
    // Both forms still share the same final policy-owned admission phase.
    // Admission, mode/key bindings and protected content must share each capture.
    // PostgreSQL needs a stable snapshot, not SSI ordering with writers. A fresh
    // policy readmission still rejects changed access/mode/key bindings. Other
    // providers retain their existing isolation/read-snapshot behavior.
    const options = {
        readOnly: true,
        isolationLevel: getDbProviderFromEnv(process.env, "postgres") === "postgres" ? "RepeatableRead" : "Serializable",
    } satisfies InTxOptions;
    const captured = typeof read === "function"
        ? await inTx(read, options)
        : await read.materialize(await inTx(read.capture, options));
    return await inTx(tx => readmit(tx, captured), options);
}
