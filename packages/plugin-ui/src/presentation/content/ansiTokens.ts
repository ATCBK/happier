export type AnsiTextStyle = Readonly<{
  foreground?: string; background?: string; bold?: boolean; dim?: boolean;
  italic?: boolean; underline?: boolean; inverse?: boolean; strikethrough?: boolean;
}>;
export type AnsiTextToken = Readonly<{ text: string; start: number; end: number; style: AnsiTextStyle }>;
export type AnsiTokenizerState = Readonly<{ style: AnsiTextStyle; pending: string; offset: number }>;
export type AnsiTokenization = Readonly<{ plainText: string; tokens: readonly AnsiTextToken[]; state: AnsiTokenizerState }>;

const ANSI_COLORS = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
] as const;
const EMPTY_STYLE: AnsiTextStyle = Object.freeze({});

function rgb(red: number, green: number, blue: number): string {
  return '#' + [red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('');
}

function paletteColor(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
  if (value < 16) return ANSI_COLORS[value];
  if (value >= 232) return rgb(8 + (value - 232) * 10, 8 + (value - 232) * 10, 8 + (value - 232) * 10);
  const cube = value - 16;
  const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
  return rgb(channel(Math.floor(cube / 36)), channel(Math.floor(cube / 6) % 6), channel(cube % 6));
}

function applySgr(previous: AnsiTextStyle, parameters: string): AnsiTextStyle {
  // Colon-delimited color parameters are the same SGR values; the empty color-space id is optional.
  const codes = parameters.replace(/\b(38|48):2:(?:0)?:/gu, '$1:2:').split(/[;:]/u).map(value => value === '' ? 0 : Number(value));
  let style = { ...previous };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4 || code === 21) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strikethrough = true;
    else if (code === 22) { delete style.bold; delete style.dim; }
    else if (code === 23) delete style.italic;
    else if (code === 24) delete style.underline;
    else if (code === 27) delete style.inverse;
    else if (code === 29) delete style.strikethrough;
    else if (code === 39) delete style.foreground;
    else if (code === 49) delete style.background;
    else if (code !== undefined && ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))) {
      style.foreground = ANSI_COLORS[code >= 90 ? code - 90 + 8 : code - 30]!;
    } else if (code !== undefined && ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))) {
      style.background = ANSI_COLORS[code >= 100 ? code - 100 + 8 : code - 40]!;
    } else if (code === 38 || code === 48) {
      let color: string | undefined;
      if (codes[i + 1] === 5) {
        color = paletteColor(codes[i + 2] ?? NaN);
        i += 2;
      } else if (codes[i + 1] === 2) {
        const channels = codes.slice(i + 2, i + 5);
        if (channels.length === 3 && channels.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
          color = rgb(channels[0]!, channels[1]!, channels[2]!);
        }
        i += 4;
      }
      if (color !== undefined) style[code === 38 ? 'foreground' : 'background'] = color;
    }
  }
  return Object.keys(style).length === 0 ? EMPTY_STYLE : style;
}

/** Read-only SGR tokenizer. OSC/DCS/control effects never become renderable or executable tokens. */
export function tokenizeAnsiText(text: string, state?: AnsiTokenizerState): AnsiTokenization {
  const input = (state?.pending ?? '') + text;
  let style = state?.style ?? EMPTY_STYLE;
  let offset = state?.offset ?? 0;
  let pending = '';
  const tokens: AnsiTextToken[] = [];
  const plain: string[] = [];
  let run = '';
  const flush = () => {
    if (!run) return;
    tokens.push({ text: run, start: offset, end: offset + run.length, style });
    plain.push(run);
    offset += run.length;
    run = '';
  };
  for (let i = 0; i < input.length;) {
    const code = input.charCodeAt(i);
    if (code === 0x1b || code === 0x9b || code === 0x9d) {
      flush();
      const start = i;
      const introducer = code === 0x1b ? input[i + 1] : code === 0x9b ? '[' : ']';
      if (introducer === undefined) { pending = input.slice(start); break; }
      i += code === 0x1b ? 2 : 1;
      if (introducer === '[') {
        const parametersStart = i;
        while (i < input.length && !(input.charCodeAt(i) >= 0x40 && input.charCodeAt(i) <= 0x7e)) i += 1;
        if (i === input.length) { pending = input.slice(start); break; }
        if (input[i] === 'm') style = applySgr(style, input.slice(parametersStart, i));
        i += 1;
      } else if (introducer === ']' || introducer === 'P' || introducer === '_' || introducer === '^') {
        while (i < input.length && input.charCodeAt(i) !== 7 && input.charCodeAt(i) !== 0x9c
          && !(input.charCodeAt(i) === 0x1b && input[i + 1] === '\\')) i += 1;
        if (i === input.length) { pending = input.slice(start); break; }
        i += input.charCodeAt(i) === 0x1b ? 2 : 1;
      } else {
        // Two-byte escapes (cursor, charset, etc.) have no text effect in a log viewer.
        while (i < input.length && input.charCodeAt(i - 1) >= 0x20 && input.charCodeAt(i - 1) <= 0x2f) i += 1;
      }
      continue;
    }
    if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f) || code === 9 || code === 10 || code === 13) run += input[i];
    i += 1;
  }
  flush();
  return { plainText: plain.join(''), tokens, state: { style, pending, offset } };
}
