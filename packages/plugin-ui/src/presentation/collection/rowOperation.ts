import { createContext } from 'react';

/** An enclosing operation lends its existing keyboard path to a composite row. */
export const HappierRowOperationContext = createContext<Readonly<{
  id: string;
  label: string;
  disabled: boolean;
  onSelect(): void;
  onKeyDown(key: string, event: unknown): boolean;
  additionalOperations?: readonly Readonly<{
    id: string;
    label: string;
    disabled: boolean;
    onSelect(): void;
  }>[];
}> | null>(null);
