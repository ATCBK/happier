export type ReviewSummary = Readonly<{ completed: number; goal: number }>;

export function readSummary(bytes: Uint8Array): ReviewSummary | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof value !== 'object' || value === null || !('completed' in value) || !('goal' in value)
            || typeof value.completed !== 'number' || !Number.isInteger(value.completed) || value.completed < 0
            || typeof value.goal !== 'number' || !Number.isInteger(value.goal) || value.goal < 1) return null;
        return { completed: value.completed, goal: value.goal };
    } catch { return null; }
}
