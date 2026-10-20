import * as React from 'react';
import { Platform } from 'react-native';

import type { AskSelection } from './useAskSelection';

type DomNodeLike = Readonly<{ parentElement?: DomElementLike | null; nodeType?: number }>;
type DomElementLike = DomNodeLike & Readonly<{ id?: string; contains?: (node: unknown) => boolean }>;

/** Rendered code rows carry `<view id>-f:<line>`: the line of a DOM node is its row's. */
export function readCodeLineFromDomNode(node: DomNodeLike | null | undefined): number | null {
    let element: DomElementLike | null | undefined = node && node.nodeType === 1 ? node as DomElementLike : node?.parentElement;
    while (element) {
        const match = typeof element.id === 'string' ? /-f:(\d+)$/u.exec(element.id) : null;
        if (match) return Number(match[1]);
        element = element.parentElement;
    }
    return null;
}

/** A rendered (Markdown) selection's lines in its source: where its first and last lines first occur. */
export function resolveSourceLinesForText(source: string, text: string): Readonly<{ startLine: number; endLine: number }> | null {
    const selected = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (selected.length === 0) return null;
    const lines = source.split(/\r?\n/u);
    const find = (needle: string, from: number) => {
        for (let index = from; index < lines.length; index += 1) if (lines[index]!.includes(needle)) return index;
        return -1;
    };
    const first = find(selected[0]!, 0);
    if (first < 0) return null;
    const last = selected.length === 1 ? first : find(selected[selected.length - 1]!, first);
    return { startLine: first + 1, endLine: (last < 0 ? first : last) + 1 };
}

/**
 * The browser's text selection inside one rendered body, as the Ask controls' selection source (web).
 * `resolveLines` maps the selection to file lines (code rows by their ids, Markdown by its source).
 */
export function useDomTextSelection(input: Readonly<{
    rootRef: React.RefObject<unknown>;
    active: boolean;
    resolveLines: (range: Readonly<{ startNode: DomNodeLike | null; endNode: DomNodeLike | null; text: string }>) => Readonly<{ startLine: number; endLine: number }> | null;
}>) {
    const latest = React.useRef(input);
    latest.current = input;
    const getSelection = React.useCallback((): AskSelection | null => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !latest.current.active) return null;
        const selection = window.getSelection?.();
        const root = latest.current.rootRef.current as DomElementLike | null;
        if (!selection || selection.rangeCount === 0 || !root?.contains) return null;
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return null;
        const text = selection.toString();
        if (selection.isCollapsed || text.trim().length === 0) return null;
        const lines = latest.current.resolveLines({ startNode: range.startContainer as DomNodeLike, endNode: range.endContainer as DomNodeLike, text });
        if (!lines) return null;
        const bounds = range.getBoundingClientRect();
        return { ...lines, text, rect: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } };
    }, []);
    const subscribeSelection = React.useCallback((listener: () => void) => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return () => {};
        document.addEventListener('selectionchange', listener);
        return () => document.removeEventListener('selectionchange', listener);
    }, []);
    return { getSelection, subscribeSelection };
}
