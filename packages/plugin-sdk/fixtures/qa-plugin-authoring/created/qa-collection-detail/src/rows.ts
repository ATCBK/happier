export type ReviewRow = Readonly<{ id: string; title: string; summary: string; completed: boolean }>;

export const initialRows: readonly ReviewRow[] = [
    { id: 'release-guide', title: 'Release guide', summary: 'Confirm the operator steps before sharing the guide.', completed: false },
    { id: 'onboarding', title: 'First session walkthrough', summary: 'Review the first-session instructions on a phone.', completed: false },
];

export function readRows(bytes: Uint8Array): readonly ReviewRow[] | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return null;
        const rows: ReviewRow[] = [];
        for (const row of value.rows) {
            if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string'
                || !('title' in row) || typeof row.title !== 'string' || !('summary' in row) || typeof row.summary !== 'string'
                || !('completed' in row) || typeof row.completed !== 'boolean') return null;
            rows.push({ id: row.id, title: row.title, summary: row.summary, completed: row.completed });
        }
        return rows;
    } catch { return null; }
}
