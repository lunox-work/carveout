/**
 * Line ranges: 1-based, both ends included, `[start, end]`. A set of them
 * is kept sorted and merged, so `[1, 5]` and `[6, 9]` are `[1, 9]`.
 */

export type Range = readonly [number, number];

/** The ranges sorted and merged, each clamped to `1..max` when `max` is given; empty ones dropped. */
export function unionRanges(ranges: Iterable<Range>, max?: number): Range[] {
  const sorted = [...ranges]
    .map(([start, end]): Range => [Math.max(1, Math.floor(start)), Math.floor(max === undefined ? end : Math.min(end, max))])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The lines a merged set covers. */
export function rangeLines(ranges: readonly Range[]): number {
  let total = 0;
  for (const [start, end] of ranges) total += end - start + 1;
  return total;
}

/** The lines of `ranges` not in `minus` (both merged). */
export function subtractRanges(ranges: readonly Range[], minus: readonly Range[]): Range[] {
  const out: Range[] = [];
  let j = 0;
  for (const [start, end] of ranges) {
    let from = start;
    while (j < minus.length && (minus[j]?.[1] ?? 0) < from) j++;
    let k = j;
    while (k < minus.length && from <= end) {
      const [cutStart, cutEnd] = minus[k] ?? [0, 0];
      if (cutStart > end) break;
      if (cutStart > from) out.push([from, cutStart - 1]);
      from = Math.max(from, cutEnd + 1);
      k++;
    }
    if (from <= end) out.push([from, end]);
  }
  return out;
}

/** The lines both merged sets cover. */
export function intersectRanges(a: readonly Range[], b: readonly Range[]): Range[] {
  const out: Range[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [aStart, aEnd] = a[i] ?? [0, 0];
    const [bStart, bEnd] = b[j] ?? [0, 0];
    const start = Math.max(aStart, bStart);
    const end = Math.min(aEnd, bEnd);
    if (start <= end) out.push([start, end]);
    if (aEnd < bEnd) i++;
    else j++;
  }
  return out;
}

/** `1-40, 88-90`: a merged set as people read it. */
export function formatRanges(ranges: readonly Range[]): string {
  return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}
