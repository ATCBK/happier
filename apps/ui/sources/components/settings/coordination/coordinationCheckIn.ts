/**
 * Check-in's two controls edit one Account value, `{ afterTurns: positive integer | null }`, where null
 * is "Never pause": the stepper shows the turn count, and the switch toggles between null and a count.
 */
export type CoordinationCheckIn = Readonly<{ afterTurns: number | null }>;

/** A typed count: a positive whole number, else null (the field returns to the saved value). */
export function parseCheckInTurns(draft: string): number | null {
    const turns = Math.floor(Number(draft));
    return Number.isFinite(turns) && turns >= 1 ? turns : null;
}

/** Never pause on keeps no count; turning it off restores the last one (or the default). */
export function withNeverPause(neverPause: boolean, lastTurns: number): CoordinationCheckIn {
    return { afterTurns: neverPause ? null : lastTurns };
}
