/** Controlled data for the shared Send to chip; inventories and persistence stay caller-owned. */
export type RecipientMultiSelectTarget<T> = Readonly<{ id: string; label: string; recipient: T }>;
export type RecipientMultiSelectModel<T> = Readonly<{
    targets: readonly RecipientMultiSelectTarget<T>[];
    selectedIds: readonly string[];
    selectedRecipients: readonly T[];
    removedRecipients: readonly T[];
    toggle(id: string): void;
    clear(): void;
}>;

export function buildRecipientMultiSelectModel<T>(input: Readonly<{
    targets: readonly RecipientMultiSelectTarget<T>[];
    recipients: readonly T[];
    key(recipient: T): string;
    onChange(recipients: readonly T[]): void;
}>): RecipientMultiSelectModel<T> {
    const selected = new Set(input.recipients.map(input.key));
    const admitted = new Set(input.targets.map(target => input.key(target.recipient)));
    const selectedRecipients = input.recipients.filter(recipient => admitted.has(input.key(recipient)));
    return {
        targets: input.targets,
        selectedIds: input.targets.filter(target => selected.has(input.key(target.recipient))).map(target => target.id),
        selectedRecipients,
        removedRecipients: input.recipients.filter(recipient => !admitted.has(input.key(recipient))),
        toggle(id) {
            const target = input.targets.find(candidate => candidate.id === id);
            if (!target) return;
            const key = input.key(target.recipient);
            input.onChange(selected.has(key)
                ? selectedRecipients.filter(recipient => input.key(recipient) !== key)
                : [...selectedRecipients, target.recipient]);
        },
        clear: () => input.onChange([]),
    };
}
