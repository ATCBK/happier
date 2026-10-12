import { inTx, type Tx } from "./inTx";

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
    const captured = typeof read === "function"
        ? await inTx(read, { readOnly: true, isolationLevel: "Serializable" })
        : await read.materialize(await inTx(read.capture, { readOnly: true, isolationLevel: "Serializable" }));
    return await inTx(tx => readmit(tx, captured), { readOnly: true, isolationLevel: "Serializable" });
}
