// 契約付録 §8・翻訳一貫性 ADR 決定3。訳注の採否は決定的（文面は LLM 生成の note/issue）。
import type { ResolvedTerm, EvalIssue, TranslatorNote } from "../types/contract.js";

export interface SegmentWarns {
  segmentId: string;
  warnIssues: EvalIssue[];
}

export interface SegmentLint {
  segmentId: string;
  untranslatedHeadings: string[];
}

export interface NotesInput {
  resolved: ResolvedTerm[];
  firstOccurrenceBySrc: Map<string, string>;
  hasConfirmed: (src: string) => boolean;
  segmentWarns: SegmentWarns[];
  segmentLints?: SegmentLint[];
}

export function buildNotes(input: NotesInput): TranslatorNote[] {
  const notes: TranslatorNote[] = [];

  for (const t of input.resolved) {
    const segmentId = input.firstOccurrenceBySrc.get(t.src);
    if (segmentId === undefined) continue; // 本文に出現しない語は対象外

    const preserve =
      t.class === "paper-defined" &&
      (t.rendering === "keep-original" || t.rendering === "bilingual");
    // 契約付録 §8 の②は「preserve に倒した語」に限定している。rendering を見ないと
    // 普通に訳した確信のある語にも訳注が付き、読み手に出る訳注が契約より増える。
    const lowConfidence =
      t.class === "established" &&
      !input.hasConfirmed(t.src) &&
      (t.rendering === "keep-original" || t.rendering === "bilingual");

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

  // 見出し未訳の非ブロッキング lint（決定的検査）。ビルドは壊さないので再訳ゲートに載せず訳注で可視化する。
  for (const seg of input.segmentLints ?? []) {
    seg.untranslatedHeadings.forEach((h, i) => {
      notes.push({
        id: `note-heading-untranslated-${seg.segmentId}-${i}`,
        trigger: "heading-untranslated",
        segmentId: seg.segmentId,
        firstOccurrence: true,
        text: `見出しが未訳の可能性: 「${h}」`,
      });
    });
  }

  return notes;
}
