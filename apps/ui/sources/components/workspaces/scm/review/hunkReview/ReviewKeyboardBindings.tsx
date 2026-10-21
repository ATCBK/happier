import { useReviewKeyboard, type ReviewKeyboardController } from './useReviewKeyboard';

export type ReviewKeyboardBindingsProps = Readonly<{
    enabled: boolean;
    /** Rich review surfaces supply their existing controller, including marks and Undo. */
    controller: ReviewKeyboardController;
    /** The reading surface supplies its focus boundary when it shares a pane with other controls. */
    containsFocus?: () => boolean;
}>;

/** Registers into the one keyboard dispatcher; it renders no surface. */
export function ReviewKeyboardBindings(props: ReviewKeyboardBindingsProps) {
    useReviewKeyboard(props.controller, { active: props.enabled, containsFocus: props.containsFocus });
    return null;
}
