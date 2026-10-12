import * as React from 'react';
import { Item, Row, Stack, Text, type TextTone } from '@happier-dev/plugin-ui';

type TriageStatusRowContent = Readonly<{
  name: string;
  /** Already localized by the source that owns the state vocabulary. */
  status?: string | undefined;
  tone?: TextTone;
}>;

/** The same source status fact, in a cockpit, story summary, or full checks list. */
export type TriageStatusRowProps = TriageStatusRowContent & (
  | Readonly<{ presentation: 'compact'; leading?: React.ReactNode; grow?: boolean }>
  | Readonly<{ presentation: 'summary'; nameVariant?: 'label' | 'micro'; nameTone?: TextTone }>
  | Readonly<{ presentation: 'list'; detail?: string; actions?: React.ReactNode }>
);

/** Presentation only: no check filtering, review decision, merge policy, or read lifecycle. */
export function TriageStatusRow(props: TriageStatusRowProps): React.ReactElement {
  if (props.presentation === 'list') {
    return <Item title={props.name} tone={props.tone ?? 'neutral'}
      {...(props.status === undefined ? {} : { subtitle: props.status })}
      {...(props.detail === undefined ? {} : { detail: props.detail })}
      accessoryOutsidePressable accessory={props.actions} />;
  }
  if (props.presentation === 'summary') {
    const name = <Text variant={props.nameVariant ?? 'label'} tone={props.nameTone ?? 'neutral'} value={props.name} />;
    if (props.status === undefined) return name;
    return <Stack gap="none">
      {name}
      <Text variant="micro" tone={props.tone ?? 'secondary'} value={props.status} />
    </Stack>;
  }
  const name = <Text variant="micro" value={props.name} />;
  return <Row gap="xsmall" align="center">
    {props.leading}
    {props.grow ? <Stack grow>{name}</Stack> : name}
    {props.status === undefined ? null : <Text variant="micro" tone={props.tone ?? 'neutral'} value={props.status} />}
  </Row>;
}
