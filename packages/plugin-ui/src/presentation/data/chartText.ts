/** An average glyph advance for the UI face at a size; chart labels are cut to their room, never drawn past it. */
// Semibold names run wider than the regular face; measured at the regular advance they ran into the lock mark.
const ADVANCE_PER_PX = { regular: 0.58, semibold: 0.64 } as const;
export type ChartTextWeight = keyof typeof ADVANCE_PER_PX;

export function textFits(text: string, room: number, fontPx: number, weight: ChartTextWeight = 'regular') {
  return text.length * fontPx * ADVANCE_PER_PX[weight] <= room;
}

export function fitText(text: string, room: number, fontPx: number, weight: ChartTextWeight = 'regular') {
  if (textFits(text, room, fontPx, weight)) return text;
  const chars = Math.floor(room / (fontPx * ADVANCE_PER_PX[weight])) - 1;
  return chars > 1 ? `${text.slice(0, chars).trimEnd()}…` : '';
}
