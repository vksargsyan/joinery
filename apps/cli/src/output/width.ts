/**
 * Terminal display width: how many columns text takes, so tables line up with CJK text, emoji
 * and combining marks. An approximation of Unicode East Asian Width that covers what terminals
 * render wide in practice.
 */

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Columns one code point takes: 0, 1 or 2. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x7f) return code >= 0x20 ? 1 : 0;
  if (ZERO_WIDTH.test(char)) return 0;
  return isWide(code) ? 2 : 1;
}

/** Columns `text` takes on a terminal. */
export function displayWidth(text: string): number {
  let width = 0;
  // ASCII fast path: most cells are plain.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  for (const char of text) width += charWidth(char);
  return width;
}

/** Cuts `text` to at most `width` columns, ending in '…' when it was cut. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

/** Pads `text` with spaces to `width` columns, on the right (left-aligned) or the left. */
export function padToWidth(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  return align === 'left' ? text + ' '.repeat(gap) : ' '.repeat(gap) + text;
}

/**
 * Makes text safe to show in one terminal cell: line breaks become '↵', tabs '⇥', and other
 * control characters (including ESC, so data cannot inject terminal escape sequences) become
 * `\xNN` escapes.
 */
export function singleLine(text: string): string {
  let clean = true;
  for (let i = 0; i < text.length; i++) {
    if (isControl(text.charCodeAt(i))) {
      clean = false;
      break;
    }
  }
  if (clean) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isControl(code)) out += text[i];
    else if (code === 13 && text.charCodeAt(i + 1) === 10) continue;
    else if (code === 10 || code === 13) out += '↵';
    else if (code === 9) out += '⇥';
    else out += `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
