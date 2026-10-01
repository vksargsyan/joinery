/**
 * Fuzzy matching for the command palette and Go to Object, as VS Code's quick open: the query's
 * characters in order anywhere in the text, case ignored and spaces skipped, scored so that word
 * starts, runs of consecutive characters and the start of the text win. The best placement is
 * found (not the first), and its positions come back for highlighting.
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Positions in the text of the matched characters, ascending. */
  readonly indices: readonly number[];
}

const SEPARATORS = new Set([' ', ':', '_', '-', '.', '/', '(', '[', '"', "'"]);

function charScore(text: string, at: number, query: string, q: number): number {
  let score = 1;
  if (at === 0) score += 8;
  else {
    const before = text[at - 1]!;
    const here = text[at]!;
    if (SEPARATORS.has(before)) score += 6;
    else if (before === before.toLowerCase() && here !== here.toLowerCase()) score += 5;
  }
  if (text[at] === query[q]) score += 1;
  return score;
}

/** How well `query` matches `text`; undefined when it does not. An empty query matches all. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const needle = query.replace(/\s+/g, '');
  if (needle === '') return { score: 0, indices: [] };
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const m = needle.length;
  const n = text.length;
  if (m > n) return undefined;
  const NONE = Number.NEGATIVE_INFINITY;
  // best[i][j]: the best score with needle[i] placed at text[j]; from[i][j]: where needle[i-1] was.
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NONE);
    const back = new Int32Array(n).fill(-1);
    // The best placement of needle[i-1] strictly before j-1 (a gap), carried as j grows.
    let runMax = NONE;
    let runAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2 && best[i - 1]![j - 2]! > runMax) {
        runMax = best[i - 1]![j - 2]!;
        runAt = j - 2;
      }
      if (lowerText[j] !== lowerNeedle[i]) continue;
      const own = charScore(text, j, needle, i) - j * 0.01;
      if (i === 0) {
        row[j] = own;
        continue;
      }
      const adjacent = j >= 1 ? best[i - 1]![j - 1]! : NONE;
      // A run of consecutive characters is worth more than a gap, and more than a word start:
      // "ord" in orders beats o…r…d at three word starts.
      const viaRun = adjacent === NONE ? NONE : adjacent + own + 8;
      const viaGap = runMax === NONE ? NONE : runMax + own;
      if (viaRun === NONE && viaGap === NONE) continue;
      if (viaRun >= viaGap) {
        row[j] = viaRun;
        back[j] = j - 1;
      } else {
        row[j] = viaGap;
        back[j] = runAt;
      }
    }
    best.push(row);
    from.push(back);
  }
  const last = best[m - 1]!;
  let end = -1;
  let score = NONE;
  for (let j = 0; j < n; j++) {
    if (last[j]! > score) {
      score = last[j]!;
      end = j;
    }
  }
  if (end < 0) return undefined;
  const indices = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i]![j]!;
  }
  return { score, indices };
}
