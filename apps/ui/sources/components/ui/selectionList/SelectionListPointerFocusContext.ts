import * as React from 'react';

/**
 * Lets an option row hand the pointer to the list's roving focus: the row under the pointer becomes the
 * one highlighted row, and the keyboard continues from there. Provided once by `SelectionList` and read
 * by `SelectionListOptionRow` (`null`: the pointer left the row), like `SelectionListInputAttentionContext`.
 */
export type SelectionListFocusOptionFromPointer = (optionId: string | null) => void;

export const SelectionListPointerFocusContext =
    React.createContext<SelectionListFocusOptionFromPointer | null>(null);
