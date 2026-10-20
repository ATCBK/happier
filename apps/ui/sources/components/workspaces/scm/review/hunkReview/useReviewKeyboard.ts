import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';

/** The focused surface chooses the unit: a change in Files, a stop in Walkthrough. */
export type ReviewKeyboardController = Readonly<{
    next: () => void;
    previous: () => void;
    keepCurrent?: () => void;
    discardCurrent?: () => void;
    askCurrent?: () => void;
    nextFile?: () => void;
    previousFile?: () => void;
    /** Omitted unless the current sticky notice has an Undo. */
    undo?: () => void;
}>;

export function useReviewKeyboard(controller: ReviewKeyboardController, options: Readonly<{
    active: boolean;
    containsFocus?: () => boolean;
}>): void {
    const run = (handler: () => void) => () => {
        if (options.containsFocus && !options.containsFocus()) return 'pass' as const;
        handler();
    };
    const handlers: KeyboardShortcutHandlers = options.active ? {
        'review.change.next': run(controller.next),
        'review.change.previous': run(controller.previous),
        ...(controller.keepCurrent ? { 'review.change.keep': run(controller.keepCurrent) } : {}),
        ...(controller.discardCurrent ? { 'review.change.discard': run(controller.discardCurrent) } : {}),
        ...(controller.askCurrent ? { 'review.change.ask': run(controller.askCurrent) } : {}),
        ...(controller.nextFile ? { 'review.file.next': run(controller.nextFile) } : {}),
        ...(controller.previousFile ? { 'review.file.previous': run(controller.previousFile) } : {}),
        ...(controller.undo ? { 'review.undo': run(controller.undo) } : {}),
    } : {};
    useKeyboardShortcutHandlers(handlers);
}
