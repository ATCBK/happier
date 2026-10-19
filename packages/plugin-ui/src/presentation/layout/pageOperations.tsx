import * as React from 'react';

/** An operation's presentation facts; its caller retains admission and execution authority. */
export type HappierPageOperation = Readonly<{
  id: string;
  title: string;
  testID?: string;
  destructive?: boolean;
  /** The page's one filled action (Save, Review changes): on a phone it stays in the header, unfolded. */
  primary?: boolean;
  disabled?: boolean;
  pending?: boolean;
  onPress: () => unknown;
}>;

export type HappierPageOperationTextResolver = (value: string | undefined, key: string | undefined) => string | undefined;

/**
 * Semantic component metadata survives separate plugin bundles; host chrome must not compare a
 * plugin's component identity with its own copy. Only operation presentation is read here.
 */
export function readHappierPageOperation(
  node: React.ReactElement,
  resolveText?: HappierPageOperationTextResolver,
): HappierPageOperation | null {
  const component = node.type;
  if ((typeof component !== 'function' && typeof component !== 'object') || component === null
    || !('happierPageOperation' in component) || typeof component.happierPageOperation !== 'function') return null;
  const read = component.happierPageOperation as (
    props: unknown, resolveText?: HappierPageOperationTextResolver,
  ) => HappierPageOperation | null;
  return read(node.props, resolveText);
}

function NormalizedPageOperation(props: Readonly<{ operation: HappierPageOperation; children: React.ReactNode }>) {
  return <>{props.children}</>;
}
NormalizedPageOperation.happierPageOperation = (props: Readonly<{ operation: HappierPageOperation }>) => props.operation;

/**
 * Resolve author text before actions leave their surface's localization scope. Generic controls
 * retain their components and context; responsive placement and folding remain with host chrome.
 */
export function normalizeHappierPageOperations(
  nodes: React.ReactNode,
  resolveText: HappierPageOperationTextResolver,
): React.ReactNode {
  return React.Children.map(nodes, node => {
    if (!React.isValidElement(node)) return node;
    const operation = readHappierPageOperation(node, resolveText);
    if (operation) return <NormalizedPageOperation operation={operation}>{node}</NormalizedPageOperation>;
    const element = node as React.ReactElement<{ children?: React.ReactNode }>;
    return element.props.children === undefined ? node
      : React.cloneElement(element, undefined, normalizeHappierPageOperations(element.props.children, resolveText));
  });
}

/**
 * Takes a page's one primary operation out of its actions, so phone chrome can keep it on the header's
 * trailing side while the remaining actions fold into the overflow. Only the first primary is taken.
 */
export function splitHappierPagePrimaryOperation(
  nodes: React.ReactNode,
  resolveText?: HappierPageOperationTextResolver,
): Readonly<{ primary: HappierPageOperation | null; rest: React.ReactNode }> {
  let primary: HappierPageOperation | null = null;
  const take = (current: React.ReactNode): React.ReactNode => React.Children.map(current, node => {
    if (primary !== null || !React.isValidElement(node)) return node;
    const operation = readHappierPageOperation(node, resolveText);
    if (operation) {
      if (operation.primary !== true) return node;
      primary = operation;
      return null;
    }
    const element = node as React.ReactElement<{ children?: React.ReactNode }>;
    return element.props.children === undefined ? node : React.cloneElement(element, undefined, take(element.props.children));
  });
  const rest = take(nodes);
  return { primary, rest };
}
