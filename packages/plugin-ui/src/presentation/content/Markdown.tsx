import type { ReactElement } from 'react';
import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';

import { HappierText } from '../text/Text.js';

/** Caller-owned citations; the host renders their presentation and routes presses back to that caller. */
export type MarkdownInlineReference = Readonly<{
  label: string;
  foreground: string;
  background: string;
  severity?: ReviewFinding['severity'];
}>;

export type MarkdownInlineReferences = Readonly<{
  scheme: string;
  resolve: (target: string) => MarkdownInlineReference | null;
  onPress?: (target: string) => void;
}>;

export type HappierMarkdownRenderInput = Readonly<{
  value: string;
  selectable: boolean;
  testID?: string;
  inlineReferences?: MarkdownInlineReferences;
}>;

export type HappierMarkdownProps = HappierMarkdownRenderInput & Readonly<{
  /** The app adapter may install its incumbent bounded Markdown renderer. */
  renderContent?: (input: HappierMarkdownRenderInput) => ReactElement;
}>;

/**
 * One semantic Markdown presentation boundary for app, declarative and public
 * Plugin UI consumers. Parsing remains app-owned; literal isolated rendering
 * remains safe and deterministic.
 */
export function HappierMarkdown(input: HappierMarkdownProps): ReactElement {
  if (input.renderContent) {
    const semanticInput: HappierMarkdownRenderInput = {
      value: input.value,
      selectable: input.selectable,
      ...(input.testID ? { testID: input.testID } : {}),
      ...(input.inlineReferences ? { inlineReferences: input.inlineReferences } : {}),
    };
    return input.renderContent(semanticInput);
  }
  return (
    <HappierText selectable={input.selectable} testID={input.testID}>
      {input.value}
    </HappierText>
  );
}
