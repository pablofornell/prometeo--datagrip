/**
 * Speed-search matching, free of UI imports so that pure logic (and its tests) can use it: substring, then word-start
 * initials. `SpeedSearch.tsx` re-exports it.
 */

export type Range = [number, number];

const isWordStart = (s: string, i: number) =>
  i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]) || (/[a-z]/.test(s[i - 1]) && /[A-Z]/.test(s[i]));

/**
 * Case-insensitive match. First a plain substring (preferring word starts), then the query as a
 * sequence of word initials ("oi" matches "order_items"). Returns the matched ranges or null.
 */
export function matchRanges(text: string, query: string): Range[] | null {
  if (!query) return null;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let idx = -1;
  for (let from = 0; ; ) {
    const i = t.indexOf(q, from);
    if (i < 0) break;
    if (idx < 0) idx = i;
    if (isWordStart(text, i)) {
      idx = i;
      break;
    }
    from = i + 1;
  }
  if (idx >= 0) return [[idx, idx + q.length]];
  // Word-initials fallback.
  const ranges: Range[] = [];
  let pos = 0;
  for (const ch of q) {
    let found = -1;
    for (let i = pos; i < t.length; i++) {
      if (t[i] === ch && (isWordStart(text, i) || (ranges.length && ranges[ranges.length - 1][1] === i))) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    pos = found + 1;
  }
  return ranges;
}
