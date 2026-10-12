import {
  memo,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';

export type HappierDiffStatKind = 'added' | 'removed';

/** The two counts as they are drawn; a side with nothing to say is `null`. */
export function formatHappierDiffStat(
  added: number,
  removed: number,
): Readonly<{ added: string | null; removed: string | null }> {
  return {
    added: added > 0 ? `+${added.toLocaleString()}` : null,
    removed: removed > 0 ? `−${removed.toLocaleString()}` : null,
  };
}

export type HappierDiffStatTextProps = Readonly<{
  /** Absent: the readout's one line. Present: one count, in that side's version-control ink. */
  kind?: HappierDiffStatKind;
  numberOfLines?: number;
  testID?: string;
  children: ReactNode;
}>;

export type HappierDiffStatProps = Readonly<{
  /** The host's tabular row-meta text, coloured per `kind` (core: its Text and version-control inks). */
  Text: ComponentType<HappierDiffStatTextProps>;
  added: number;
  removed: number;
  testID?: string;
  /** Draws one count itself (a find-highlighted run); it must keep that side's ink. */
  renderCount?: (kind: HappierDiffStatKind, text: string) => ReactNode;
}>;

/**
 * Lines added and removed as one tabular readout ("+53 −5"), in the version-control inks. A side
 * with nothing to say is left out; with neither, nothing is drawn. Happier core and plugin surfaces
 * draw the readout with this one owner; each host supplies only its text owner and inks.
 */
export const HappierDiffStat = memo(function HappierDiffStat(
  props: HappierDiffStatProps,
): ReactElement | null {
  if (props.added <= 0 && props.removed <= 0) return null;
  const { Text } = props;
  const counts = formatHappierDiffStat(props.added, props.removed);
  const count = (kind: HappierDiffStatKind, text: string) =>
    props.renderCount ? (
      props.renderCount(kind, text)
    ) : (
      <Text kind={kind}>{text}</Text>
    );
  return (
    <Text
      numberOfLines={1}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {counts.added ? count('added', counts.added) : null}
      {props.added > 0 && props.removed > 0 ? ' ' : null}
      {counts.removed ? count('removed', counts.removed) : null}
    </Text>
  );
});
