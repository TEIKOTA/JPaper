// 契約付録 §4・§8。文書全体・順序ベースの初出セグメント判定（分割不変）。
export interface SegmentRef {
  id: string;
  latex: string;
}

export function buildFirstOccurrenceIndex(
  segments: SegmentRef[],
  srcs: string[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const seg of segments) {
    for (const src of srcs) {
      if (src !== "" && !index.has(src) && seg.latex.includes(src)) {
        index.set(src, seg.id);
      }
    }
  }
  return index;
}

export function isFirstOccurrence(
  index: Map<string, string>,
  segmentId: string,
  src: string,
): boolean {
  return index.get(src) === segmentId;
}
