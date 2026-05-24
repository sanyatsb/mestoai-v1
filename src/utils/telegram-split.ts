// [AUDIT-A4] Split text into chunks <= maxChars while trying to break on
// paragraph / line / sentence / word boundaries — never mid-word if avoidable.
// Telegram caps a single message at 4096 chars; default to 4000 for safety.

const DEFAULT_MAX = 4000;

export function splitForTelegram(text: string, maxChars: number = DEFAULT_MAX): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    const slice = rest.slice(0, maxChars);
    const cutAt = findBreakPoint(slice);
    parts.push(rest.slice(0, cutAt).trimEnd());
    rest = rest.slice(cutAt).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

function findBreakPoint(slice: string): number {
  // Prefer the latest paragraph break, then line break, then sentence end, then space.
  const candidates: number[] = [
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf(' '),
  ];
  for (const idx of candidates) {
    if (idx > slice.length * 0.5) return idx + 1;
  }
  // Fallback: hard cut.
  return slice.length;
}
