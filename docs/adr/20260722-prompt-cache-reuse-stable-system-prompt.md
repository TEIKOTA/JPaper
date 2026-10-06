# 2026/07/22 プロンプトキャッシュ再利用: system prompt を role ごとに安定化し per-segment 用語スライスを user へ移す

# Status
- accepted（brief/style を system prompt へ置く部分は [プロンプト注入 ADR](./20260811-untrusted-text-never-becomes-instructions.md) 決定1 で改められた。prefix 安定化という主旨は有効）

# Situation
- コスト調査でユーザーが費用に驚愕。「コストを抑えつつ性能を保つ」が最優先目標。
- LLM トレース（[LLM トレース ADR](./20260722-llm-call-trace-local-jsonl.md)）を入れ、実 run のコスト内訳を計測できるようになった。

# Context
- トレース解析で、本番の全 LLM コールが **cacheRead=0・cacheCreation≈8000tok/call** ＝ プロンプトキャッシュが全く効いていないと判明。cache_write は base 入力の約1.25倍課金・cache_read は約0.1倍なので、毎回フル書き込みは高コスト。
- 診断（完全に同一の system/user を持つ `complete()` を3連投）で、**claude CLI は別プロセス呼び出し間でもプロンプトキャッシュを再利用する**ことを確認: 1回目 cacheCreation=7879/$0.089、2回目以降 cacheRead=7879/$0.015（**約83%減**）。つまりキャッシュは効くのに、本番はプロンプトが毎回変わるため prefix が共有されていなかった。
- 原因: `buildSystemPrompt` の可変部が **per-segment の確定用語スライス**（`renderRunContext` の「確定用語・表記」）だけ。ROLE_DEF/COMMON/brief/style/role固有指示は本来 run 内で一定なのに、スライスが毎セグメント変わるため system prompt 全体が変わり、同一 role のコール間でもキャッシュ prefix を共有できなかった。

# Material for decision
- ベースライン・診断・before/after のトレース（`analyze-trace` ツール = 別 PR で計測）。
- Anthropic プロンプトキャッシュの prefix 一致・5分 TTL の性質。claude CLI は system prompt を prefix としてキャッシュする（診断で cacheRead が付くことを実証）。

# Decision
- **per-segment の確定用語ブロックを system prompt から user メッセージへ移す**（`renderGlossaryBlock` として切り出し、translator/evaluator の user に載せる）。
- system prompt は role ごとに **ROLE_DEF＋COMMON＋brief/style＋role固有指示** だけで構成し、run 内で一定にする（`brief`/`style` は per-paper で run 内不変）。これにより同一 role のコールは2回目以降 system prefix が cache_read ヒットする。
- 情報量・`firstOccurrence` 依存の指示（bilingual 初出/以降）は不変で、system→user へ**位置だけ**移す。性能非退行を狙う。

# Consequences
- 良い面（before/after プローブ実測、Attention 先頭3セグメント・N=3/role）:
  - 同一 role の2コール目以降で cacheRead>0（system prefix 〜3800tok が読み出しに）。
  - 定常状態（キャッシュが効くコール）で **1コールあたり約36.5%のコスト減**。6セグメントコール合計で 24.9%減（N が大きい実 run では定常状態が支配的で漸近的にさらに改善。translator+evaluator はコストの約78%）。
  - 3セグメントとも passed=true・revisions=0＝品質非退行を確認。
- トレードオフ:
  - user メッセージ側に残る可変部（セグメント本文＋用語ブロック）は依然コールごとに cache_write される（prefix 共有できない）。用語ブロックは per-segment の `firstOccurrence` を含むため完全な安定化はしない。さらなる削減（用語の安定部を共有・COMMON/brief/style を role 間で共有する prefix 並べ替え）は将来の enhancement。
  - system prompt の構成順・確定用語の配置が変わり、契約付録 §8/§13A の記述を更新した（用語＝user、brief/style＝system）。
  - キャッシュ再利用は 5分 TTL に依存。同一 role のコール間隔が空くと write に戻る（実 run の頻度なら概ね read）。
