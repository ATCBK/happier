// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { attachChipRailReveal, resolveChipRailRevealDelta } from './attachChipRailReveal';

describe('resolveChipRailRevealDelta', () => {
    const viewportWidth = 300;
    const chip = (left: number, right: number) => ({ left, right });

    it('leaves a rail alone when the control and both neighbours are whole', () => {
        expect(resolveChipRailRevealDelta({ viewportWidth, control: chip(100, 180), previous: chip(10, 90), next: chip(190, 270) })).toBe(0);
    });

    it('brings the clipped previous neighbour whole when the control sits at the leading edge', () => {
        expect(resolveChipRailRevealDelta({ viewportWidth, control: chip(8, 88), previous: chip(-70, 0), next: chip(98, 178) })).toBe(-70);
    });

    it('brings the next neighbour whole when the control sits at the trailing edge', () => {
        expect(resolveChipRailRevealDelta({ viewportWidth, control: chip(210, 290), next: chip(300, 380), previous: chip(120, 200) })).toBe(80);
    });

    it('reveals the control alone when it and a neighbour cannot both fit', () => {
        expect(resolveChipRailRevealDelta({ viewportWidth, control: chip(-30, 260), next: chip(270, 380) })).toBe(-30);
        expect(resolveChipRailRevealDelta({ viewportWidth, control: chip(50, 340), previous: chip(-40, 40) })).toBe(40);
    });
});

describe('attachChipRailReveal', () => {
    function railWithChips(rects: ReadonlyArray<readonly [number, number]>) {
        const node = document.createElement('div');
        const chips = rects.map(() => {
            const button = document.createElement('button');
            node.appendChild(button);
            return button;
        });
        node.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 28, width: 300, height: 28, x: 0, y: 0, toJSON: () => ({}) });
        Object.defineProperty(node, 'clientWidth', { value: 300 });
        node.scrollLeft = 500;
        chips.forEach((button, index) => {
            const [left, right] = rects[index]!;
            // Chip rects follow the rail's scroll position, as in a browser.
            button.getBoundingClientRect = () => {
                const shift = -node.scrollLeft;
                return { left: left + shift, right: right + shift, top: 0, bottom: 28, width: right - left, height: 28, x: left + shift, y: 0, toJSON: () => ({}) };
            };
        });
        return { node, chips };
    }

    it('reports every scroll the rail makes, so the edge fades follow a smooth or programmatic scroll to its end', () => {
        const { node } = railWithChips([[0, 100]]);
        const onScroll = vi.fn();
        const cleanup = attachChipRailReveal({ node, onScroll });
        node.dispatchEvent(new Event('scroll'));
        node.dispatchEvent(new Event('scroll'));
        expect(onScroll).toHaveBeenCalledTimes(2);
        cleanup();
        node.dispatchEvent(new Event('scroll'));
        expect(onScroll).toHaveBeenCalledTimes(2);
    });

    it('scrolls a focused chip and its neighbour whole instead of leaving one cut mid-word', () => {
        // Rail scrolled to 500: chips at content x 420..500 (cut at the leading edge), 510..590, 600..680, 690..770.
        const { node, chips } = railWithChips([[420, 500], [510, 590], [600, 680], [690, 770]]);
        const cleanup = attachChipRailReveal({ node, onScroll: () => {} });
        chips[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(node.scrollLeft).toBe(420);
        cleanup();
    });

    it('holds the reveal of a pointer-focused chip until the press is released, so the click still lands on that chip', () => {
        const { node, chips } = railWithChips([[420, 500], [510, 590], [600, 680], [690, 770]]);
        document.body.appendChild(node);
        const cleanup = attachChipRailReveal({ node, onScroll: () => {} });
        chips[0]!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        chips[0]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        // The chip must not move under the pointer between press and release: a click needs both on one chip.
        expect(node.scrollLeft).toBe(500);
        chips[0]!.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(node.scrollLeft).toBe(420);
        cleanup();
        node.remove();
    });

    it('leaves the rail at rest when the pressed chip is whole, even beside a cut neighbour', () => {
        const { node, chips } = railWithChips([[420, 500], [510, 590], [600, 680], [690, 770]]);
        document.body.appendChild(node);
        const cleanup = attachChipRailReveal({ node, onScroll: () => {} });
        chips[1]!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        chips[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        chips[1]!.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(node.scrollLeft).toBe(500);
        cleanup();
        node.remove();
    });

    it('scrolls a pressed chip clear of the trailing scroll indicator, where the rail mask would hide it', () => {
        // Rail scrolled to 500: the third chip ends exactly at the viewport edge, under the trailing indicator.
        const { node, chips } = railWithChips([[520, 600], [610, 700], [710, 800], [810, 900]]);
        document.body.appendChild(node);
        const cleanup = attachChipRailReveal({ node, onScroll: () => {} });
        chips[2]!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        chips[2]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        chips[2]!.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(node.scrollLeft).toBe(524);
        cleanup();
        node.remove();
    });

    it('leaves a rail the person dragged where it was dropped instead of revealing the pressed chip', () => {
        const { node, chips } = railWithChips([[420, 500], [510, 590], [600, 680], [690, 770]]);
        document.body.appendChild(node);
        const cleanup = attachChipRailReveal({ node, onScroll: () => {} });
        chips[0]!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        chips[0]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        node.scrollLeft = 460;
        chips[0]!.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(node.scrollLeft).toBe(460);
        cleanup();
        node.remove();
    });
});
