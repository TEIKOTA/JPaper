---
name: decide-or-proceed
description: Use when working autonomously and tempted to stop for user confirmation - decides pause vs proceed. Default is PROCEED with stated assumptions; stop only for irreversible/external effects, protected-resource consumption, changes to explicit prior agreements, or when every interpretation wastes the work.
---

# Decide or Proceed

自律作業中の「止まるか、進むか」の判定規約。既定は**止まらず進む**。
ユーザーは「勝手に止まる」と「確認しすぎ」の両方を望まない（複数プロジェクトの
セッション実測。「なぜ作業を止めているのですか」「いちいち確認は必要ありません」）。
確認のために手を止めてよいのは、次の 4 条件のいずれかに該当する時だけ。

## 止まってよい 4 条件

1. **不可逆・外部影響**: 取り消せない操作（削除・公開・送信・課金・履歴書き換え）や、
   repo の外へ影響が出る操作を伴う。
2. **保護資源の消費**: 事前に「触らない・使い切らない」と合意した資源
   （凍結データ・残量の少ない quota やディスク・本番環境）を消費する。
3. **事前合意の変更**: ユーザーと明示的に合意した方針・仕様・制約を変えることになる。
4. **どちらでも無駄**: 解釈が複数あり、どの解釈で進めても作業の半分以上が捨てになる。

## 進み方

- 4 条件に該当しなければ、**仮定を明記して進む**。応答に「〜と仮定して進めた」を残し、
  仮定が外れても巻き戻せる単位で作業を刻む。
- 判断に使った仮定・却下した代替案のうち後の判断に効くものは、対象 issue か
  決定レジスタ（`docs/process/decisions.md`）へ記録し、会話ログだけに残さない。
- 品質不満の報告を受けた時は「まず報告のみ」: 診断と修正計画を提示して止まり、
  着手はユーザーの明示指示を待つ（勝手に直し始めない。条件 3 に該当する停止）。

## 自律作業の開始前（契約）

長い自律作業に入る前に、次が確定しているか確認する。未確定が多ければ `grill-me` の
契約チェックリストで揃えてから開始する:
ゴール / 期限・目安 / 停止条件（上の 4 条件の具体化） / 報告頻度 /
資源上限（API 課金・ディスク・quota） / 不可侵領域（触らないファイル・環境）。

## 関連

- `.agents/skills/grill-me/SKILL.md` — 開始前の認識合わせと契約チェックリスト
- AGENTS.md 編集ガードレール — 破壊的操作・UI/UX 確認など個別の停止条件の正本
