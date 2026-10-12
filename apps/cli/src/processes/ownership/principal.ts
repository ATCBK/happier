/**
 * Single principal comparison consumed by census projections and ownership evidence.
 *
 * `terminate_detected` is the only affordance that signals a process the daemon did not spawn,
 * and its eligibility gate was previously vacuous: `processOwnershipConfidence` was set to
 * `medium` for every listener that had a pid, so the whole confidence ladder reduced to "the
 * listener has a pid" — and on Windows that meant a system service was a terminate candidate.
 *
 * The gate requires **positive ownership evidence** (RU2 surfaces finalization, DEC-14).
 * Ownership is an identity comparison on every platform, so there is one comparison here and the
 * platforms differ only in which identity they can read:
 *
 *  - **POSIX** compares real uids supplied by the native Darwin census or Linux procfs.
 *  - **Windows** compares owner SIDs supplied by the same native census.
 *
 * **Access is deliberately not accepted as evidence.** This previously answered the Windows
 * question with `process.kill(pid, 0)` — whether the daemon may *open the target for
 * termination*. That is a different question, and it answers "yes" for the whole machine when the
 * daemon runs elevated, which is a supported install (`schtasks-system`). A privileged daemon
 * would therefore have graded every system service as its own and offered to terminate it. The
 * signal-access probe is removed rather than demoted, so nothing can reintroduce it as a second
 * decision-maker.
 *
 * `undefined` means the platform could not establish ownership. It is deliberately distinct from
 * `'other'`: the scanner maps it to `medium`, and the terminate gate refuses `medium` with the
 * typed `ownership_not_established`. Failing to read an identity therefore denies the action —
 * it never approves it.
 */
export type LocalServiceProcessOwnership = 'self' | 'other';

export function compareProcessPrincipals(
    target: Readonly<{ kind: 'uid' | 'sid'; value: string }> | null,
    daemon: Readonly<{ kind: 'uid' | 'sid'; value: string }> | null,
): LocalServiceProcessOwnership | undefined {
    if (!target || !daemon) return undefined;
    if (target.kind !== daemon.kind) return 'other';
    return classifyProcessOwnershipByIdentity(target.value, daemon.value);
}

/** The daemon's own POSIX real uid, or `undefined` on a platform without one. */
export function resolveDaemonPosixUserId(): string | undefined {
    const uid = process.getuid?.();
    return typeof uid === 'number' ? String(uid) : undefined;
}

/**
 * Compare a process's owning principal with the daemon's. POSIX passes uids, Windows passes
 * SIDs; the decision is the same one, so it lives in one place. A missing identity on either
 * side is `undefined` — never `'self'`.
 */
export function classifyProcessOwnershipByIdentity(
    processIdentity: string | undefined,
    daemonIdentity: string | undefined,
): LocalServiceProcessOwnership | undefined {
    if (!processIdentity || !daemonIdentity) return undefined;
    return processIdentity === daemonIdentity ? 'self' : 'other';
}
