import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { PDF_ZOOM_PRESETS, type PdfZoom } from './pdfZoom';

const FIT_WIDTH = 'fit-width';
const FIT_PAGE = 'fit-page';

function zoomId(zoom: PdfZoom): string {
  return typeof zoom === 'number' ? String(zoom) : zoom;
}

/**
 * The PDF zoom control for the File page header (lab files FV5z): presets 50–400 %, Fit width and
 * Fit page. `percent` is the viewer's current absolute scale, so a fit mode still reads as a number.
 */
export function PdfZoomMenu(
  props: Readonly<{
    zoom: PdfZoom;
    percent: number | null;
    onZoomChange: (zoom: PdfZoom) => void;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo<DropdownMenuItem[]>(
    () => [
      { id: FIT_WIDTH, title: t('files.viewer.pdfFitWidth') },
      { id: FIT_PAGE, title: t('files.viewer.pdfFitPage') },
      ...PDF_ZOOM_PRESETS.map((preset) => ({
        id: String(preset),
        title: t('files.viewer.zoomPercent', {
          percent: Math.round(preset * 100),
        }),
      })),
    ],
    [],
  );
  const label =
    props.zoom === FIT_WIDTH
      ? t('files.viewer.pdfFitWidth')
      : props.zoom === FIT_PAGE
        ? t('files.viewer.pdfFitPage')
        : t('files.viewer.zoomPercent', {
            percent: props.percent ?? Math.round(props.zoom * 100),
          });
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={zoomId(props.zoom)}
      // The trigger reads the current zoom; the list sizes to its longest choice ("Fit width"), not to the trigger.
      matchTriggerWidth={false}
      popoverAccessibilityLabel={t('files.viewer.pdfZoom')}
      onSelect={(id) => {
        setOpen(false);
        props.onZoomChange(
          id === FIT_WIDTH || id === FIT_PAGE ? id : Number(id),
        );
      }}
      trigger={({ toggle }) => (
        <RoundButton
          size="small"
          display="secondary"
          title={label}
          accessibilityLabel={`${t('files.viewer.pdfZoom')}: ${label}`}
          trailing={
            <Icon
              name="caret-down"
              size={12}
              color={theme.colors.text.secondary}
            />
          }
          onPress={toggle}
          {...(props.testID ? { testID: `${props.testID}-trigger` } : {})}
        />
      )}
    />
  );
}
