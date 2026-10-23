import * as React from 'react';
import { Button, HAPPIER_TYPE_SCALE, Row, Stack, usePluginTranslation } from '@happier-dev/plugin-ui';

/** How much of a long text the preview shows before "Show more": a few paragraphs of reading text. */
const PREVIEW_PX = HAPPIER_TYPE_SCALE.reading.lineHeight * 9;

/**
 * A long provider text (a pull request description, a bot's comment) previewed at a bounded height, opened
 * whole on request. It keeps the story's later steps and the timeline's later events in view (lab: the ask,
 * What changed and the checks all in the first screen). A text that fits is shown whole with nothing to open.
 */
export function TriageTextPreview({ children, testID }: Readonly<{ children: React.ReactNode; testID?: string }>): React.ReactElement {
  const text = usePluginTranslation();
  const [height, setHeight] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState(false);
  // A line of slack, so a text barely over the preview is shown whole rather than cut by one line.
  const long = height !== null && height > PREVIEW_PX + HAPPIER_TYPE_SCALE.reading.lineHeight;
  return <Stack gap="small">
    <Stack style={long && !open ? { maxHeight: PREVIEW_PX, overflow: 'hidden' } : undefined}>
      <Stack gap="large" {...(testID === undefined ? {} : { testID })}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>{children}</Stack>
    </Stack>
    {long ? <Row>
      <Button variant="plain" size="small"
        title={open ? text('plugins.triage.detailStory.showLess', 'Show less') : text('plugins.triage.detailStory.showMore', 'Show more')}
        onPress={() => setOpen((current) => !current)} />
    </Row> : null}
  </Stack>;
}
