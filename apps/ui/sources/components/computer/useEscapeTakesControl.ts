import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

/**
 * Esc requests takeover while the Agent owns input; after takeover the target handles it. It is a
 * layer on the canonical escape stack, so an open menu, popover, modal or pane takes Escape first:
 * dismissing a menu never takes control of the computer.
 */
export function useEscapeTakesControl(
  active: boolean,
  takeControl: () => void,
): void {
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.computerTakeControl,
    enabled: active,
    onEscape: (event) => {
      // Escape inside a floating frame's own chrome is the frame's (it restores an expanded view).
      const target = (event as { target?: unknown } | null)?.target as
        | Element
        | null
        | undefined;
      if (target?.closest?.('[data-happier-floating-frame="true"]'))
        return false;
      takeControl();
      return true;
    },
  });
}
