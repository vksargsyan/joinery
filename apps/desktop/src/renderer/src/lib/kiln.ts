/**
 * The Kiln design system's colours for the parts of the app drawn on a canvas or themed through
 * an API rather than CSS: Monaco and Glide Data Grid. The DOM takes the same values from the
 * `--k-*` properties in styles.css (a test keeps the two identical). Tenmoku is the dark theme,
 * Bisque the light one.
 */

export interface KilnPalette {
  readonly bg: string;
  readonly bgDeep: string;
  readonly bgRaised: string;
  readonly bgHover: string;
  readonly bgActive: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly lineHighlight: string;
  readonly fg: string;
  readonly muted: string;
  readonly faint: string;
  readonly comment: string;
  readonly punct: string;
  readonly rust: string;
  readonly cobalt: string;
  readonly celadon: string;
  readonly ochre: string;
  readonly lilac: string;
  readonly peach: string;
  readonly teal: string;
  readonly red: string;
  readonly onAccent: string;
  readonly accentHover: string;
  readonly focusBorder: string;
  readonly selectionText: string;
  readonly listActive: string;
  readonly listFocus: string;
  readonly listHover: string;
  readonly badgeBg: string;
  readonly findMatch: string;
  readonly scrollbar: string;
  readonly scrollbarHover: string;
  readonly scrollbarActive: string;
  readonly shadowWidget: string;
}

export const TENMOKU: KilnPalette = {
  bg: '#161412',
  bgDeep: '#110f0e',
  bgRaised: '#1e1b18',
  bgHover: '#25211d',
  bgActive: '#2c2722',
  border: '#2a2520',
  borderStrong: '#3a342d',
  lineHighlight: '#1d1a17',
  fg: '#e6ded0',
  muted: '#a39a8b',
  faint: '#6b6358',
  comment: '#8a8172',
  punct: '#9c9384',
  rust: '#e8906a',
  cobalt: '#8fb0f0',
  celadon: '#a3cba8',
  ochre: '#e9bc6c',
  lilac: '#c9a8ee',
  peach: '#edc7a3',
  teal: '#7fcbc6',
  red: '#f07d72',
  onAccent: '#1a1310',
  accentHover: '#f0a07d',
  focusBorder: '#e8906a99',
  selectionText: '#e8906a59',
  listActive: '#e8906a29',
  listFocus: '#e8906a1f',
  listHover: '#e6ded00d',
  badgeBg: '#e8906a33',
  findMatch: '#e9bc6c66',
  scrollbar: '#e6ded014',
  scrollbarHover: '#e6ded024',
  scrollbarActive: '#e8906a66',
  shadowWidget: '#00000066',
};

export const BISQUE: KilnPalette = {
  bg: '#f6f1e7',
  bgDeep: '#eee7da',
  bgRaised: '#fbf8f2',
  bgHover: '#e8e0d1',
  bgActive: '#e0d6c4',
  border: '#dfd5c3',
  borderStrong: '#cfc3ae',
  lineHighlight: '#efe8db',
  fg: '#2b2620',
  muted: '#6b6255',
  faint: '#a89e8e',
  comment: '#716759',
  punct: '#6e6557',
  rust: '#aa4924',
  cobalt: '#2d5bb5',
  celadon: '#3a7549',
  ochre: '#8f5d0e',
  lilac: '#7a48ac',
  peach: '#9a4e28',
  teal: '#1c7470',
  red: '#c0392e',
  onAccent: '#fff8f0',
  accentHover: '#933c1b',
  focusBorder: '#aa492499',
  selectionText: '#aa492459',
  listActive: '#aa492429',
  listFocus: '#aa49241f',
  listHover: '#2b26200d',
  badgeBg: '#aa492433',
  findMatch: '#8f5d0e66',
  scrollbar: '#2b262014',
  scrollbarHover: '#2b262024',
  scrollbarActive: '#aa492466',
  shadowWidget: '#5a452a22',
};

export function kilnPalette(theme: 'dark' | 'light'): KilnPalette {
  return theme === 'dark' ? TENMOKU : BISQUE;
}

/** A colour with an alpha, as `#rrggbbaa` (for Monaco's and the grid's washes). */
export function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return `${hex.slice(0, 7)}${byte.toString(16).padStart(2, '0')}`;
}

/** Code and data: Rec Mono Duotone (its roman is Rec Mono Linear; the italic is a cursive). */
export const CODE_FONT = "'Rec Mono Duotone', 'SF Mono', Menlo, Consolas, monospace";
