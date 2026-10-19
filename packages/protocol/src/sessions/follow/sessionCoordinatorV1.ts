/** Admitted relation facts only. Omission is unavailable, never an empty relation set. */
export type SessionCoordinatorFactsV1 = Readonly<{
    managedSessions?: Readonly<{ total: number }> | null;
    /** Derived from the viewer's private Follow rows; never a persisted Session flag. */
    receivedRuleCount?: number;
}>;

/** One derivation for filters, row marks and controls; roles do not establish membership. */
export function deriveSessionCoordinatorV1(facts: SessionCoordinatorFactsV1): boolean | undefined {
    const managed = facts.managedSessions?.total;
    const rules = facts.receivedRuleCount;
    if ((managed !== undefined && managed > 0) || (rules !== undefined && rules > 0)) return true;
    return managed === 0 && rules === 0 ? false : undefined;
}
