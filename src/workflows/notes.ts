// 契約付録 §8・翻訳一貫性 ADR 決定3。訳注の採否は決定的（文面は LLM 生成の note/issue）。
import type { ResolvedTerm, EvalIssue, TranslatorNote } from "../types/contract.js";

export interface SegmentWarns {
  segmentId: string;
  warnIssues: EvalIssue[];
}

export interface NotesInput {
  resolved: ResolvedTerm[];
  firstOccurrenceBySrc: Map<string, string>;
  hasConfirmed: (src: string) => boolean;
  segmentWarns: SegmentWarns[];
}

export function buildNotes(input: NotesInput): TranslatorNote[] {
  const notes: TranslatorNote[] = [];

  for (const t of input.resolved) {
    const segmentId = input.firstOccurrenceBySrc.get(t.src);
    if (segmentId === undefined) continue; // 本文に出現しない語は対象外

    const preserve =
      t.class === "paper-defined" &&
      (t.rendering === "keep-original" || t.rendering === "bilingual");
    const lowConfidence = t.class === "established" && !input.hasConfirmed(t.src);

    if (preserve) {
      notes.push({
        id: `note-paper-defined-preserve-${t.src}`,
        trigger: "paper-defined-preserve",
        src: t.src,
        segmentId,
        firstOccurrence: true,
        text: t.note ?? `${t.src} は論文定義語のため ${t.rendering} で扱う`,
      });
    } else if (lowConfidence) {
      notes.push({
        id: `note-low-confidence-${t.src}`,
        trigger: "low-confidence",
        src: t.src,
        segmentId,
        firstOccurrence: true,
        text: t.note ?? `${t.src} は確定訳が未確認（低確信）`,
      });
    }
  }

  for (const seg of input.segmentWarns) {
    seg.warnIssues.forEach((issue, i) => {
      notes.push({
        id: `note-evaluator-warn-${seg.segmentId}-${i}`,
        trigger: "evaluator-warn",
        segmentId: seg.segmentId,
        firstOccurrence: true,
        text: issue.message,
      });
    });
  }

  return notes;
}
