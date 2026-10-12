export type SessionInstructionsAuthoringDraft = Readonly<{ title: string; markdown: string }>;

/** Device-local unsaved authoring recovers only the two known editor fields. */
export function readSessionInstructionsAuthoringDraft(value: unknown): SessionInstructionsAuthoringDraft | null | undefined {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const title: unknown = Reflect.get(value, 'title');
    const markdown: unknown = Reflect.get(value, 'markdown');
    return typeof title === 'string' && typeof markdown === 'string' ? { title, markdown } : undefined;
}
