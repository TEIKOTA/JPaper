// 契約付録 §1・設計メモ §13A。3部品固定順の system-prompt ビルダー（決定的出力）。
import type { ResolvedTerm, DocumentBrief, StyleContract } from "../types/contract.js";

export type AgentRole = "translator" | "evaluator" | "glossary-builder";

export interface RunContext {
  glossary: ResolvedTerm[];
  brief?: DocumentBrief;
  style?: StyleContract;
}

const ROLE_DEF: Record<AgentRole, string> = {
  translator:
    "あなたは学術論文の本文（散文）だけを日本語に翻訳する専門家である。構造・数式・図・引用は与えられた LaTeX のまま保持し、地の文のみ訳す。出力は指定の JSON のみ。",
  evaluator:
    "あなたは日本語訳の品質を評価する審査者である。原文と訳文を比較し、verdict（pass/revise/fail）と issues を返す。出力は指定の JSON のみ。",
  "glossary-builder":
    "あなたは論文全体を読み、用語の確定訳・表記方針・文書ブリーフ・文体契約を定める編纂者である。出力は指定の JSON のみ。",
};

const COMMON =
  "共通規約: 構造・数式（$..$ / \\[..\\] / 各種環境）・図・表・引用番号・組版はコードが管理する。あなたは本文のみを扱い、これらのマークアップは改変・削除・追加しない。段落数を水増ししない。応答は前後に散文やコードフェンスを付けず、指定スキーマの JSON のみを返す。";

const PITFALLS =
  "頻出の誤訳に注意する（evaluator 用チェックリスト）: 統計語 significantly=「有意」（p 値の含意を保つ）／SI 単位は立体・°K は K に／主張強度・hedging（may/might/suggest 等）を原文どおり保つ／false friend: agency=「行為主体性」など文脈依存の訳。";

function renderTerms(glossary: ResolvedTerm[]): string {
  if (glossary.length === 0) return "（確定用語なし）";
  return [...glossary]
    .sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))
    .map((t) => {
      const note = t.note ? ` 〔訳注: ${t.note}〕` : "";
      const first = t.firstOccurrence ? " [初出]" : "";
      return `- ${t.src} → ${t.form} (${t.class}/${t.rendering})${first}${note}`;
    })
    .join("\n");
}

function renderBrief(brief: DocumentBrief): string {
  const roles = brief.sectionRoles.map((r) => `  - ${r.id}: ${r.role}`).join("\n");
  return [
    `主張の核: ${brief.thesis}`,
    `節の役割:\n${roles}`,
    `記法規約: ${brief.notationConventions.join(" / ")}`,
    `主張強度の注意: ${brief.claimStrengthNotes.join(" / ")}`,
  ].join("\n");
}

function renderStyle(style: StyleContract): string {
  return [
    `文体: ${style.register === "plain" ? "である調・常体" : "ですます調・敬体"}`,
    `時制: ${style.tensePolicy}`,
    `見出し: ${style.headingStyle}`,
    `数字・単位: ${style.numberStyle}`,
    style.notes.length > 0 ? `備考: ${style.notes.join(" / ")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function renderRunContext(ctx: RunContext): string {
  const parts = [`## 確定用語・表記\n${renderTerms(ctx.glossary)}`];
  if (ctx.brief) parts.push(`## 文書ブリーフ\n${renderBrief(ctx.brief)}`);
  if (ctx.style) parts.push(`## 文体契約\n${renderStyle(ctx.style)}`);
  return parts.join("\n\n");
}

export function buildSystemPrompt(role: AgentRole, ctx: RunContext): string {
  const parts = [ROLE_DEF[role], COMMON, renderRunContext(ctx)];
  if (role === "evaluator") parts.push(PITFALLS);
  return parts.join("\n\n---\n\n");
}
