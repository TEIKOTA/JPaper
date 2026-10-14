# 2026/10/14 public にした JPaper では GitHub Actions を有効にする

# Status
- accepted

# Situation
- 2026-10-14、利用者は JPaper を public な OSS にすると決めた（issue #356）。あわせて、止めていた CI（pr-checks・self-test）も戻し、node-checks と合わせて 3 本とも動かすと決めた。
- [Actions 既定オフ ADR](./20260901-disable-github-actions-by-default.md) は、private repo の無料枠（月 2,000 分）をアカウントの全 repo で共有し、枯渇すると全プロジェクトの CI が止まることを理由に、Actions を既定で止めた。

# Context
- public repo では、標準の GitHub ホストランナーの実行時間は課金されず、無料枠も消費しない。20260901 の理由（private の無料枠の取り合い）は、public にした JPaper には当てはまらない。
- 検査の中身はもともとローカルの scripts（`bash tests/run-tests.sh`・`scripts/check-pr.sh`）と `pnpm test`・`pnpm typecheck`・`pnpm build` で、CI は実行の場を足すだけである。self-test は macOS（bash 3.2）と Linux の両方で走らせられる。
- CI の条件はローカルと違う。checkout は detached HEAD になり、macOS の runner は `en_US.UTF-8` で動く可能性がある（未検証。macOS の awk はこの locale で文字列を照合順序で比べ、異なる漢字の見出しを等しいと判定する）。独立レビューで、self-test がこの 2 つの条件で落ちることを手元で再現し、#356 で直した。runner の locale は初回の CI の実行で確かめる。
- public にすると、fork からの PR でも workflow が走る。pr-checks は `pull_request`（`pull_request_target` ではない）で、base 側の commit の scripts で検査するので、PR 側の変更で検査を迂回できず、secret も渡らない。

# Material for decision
- [20260901-disable-github-actions-by-default.md](./20260901-disable-github-actions-by-default.md)（決定 1〜3 と Consequences）
- GitHub Docs「About billing for GitHub Actions」（public repo の標準ランナーは無料）
- issue #356

# Decision
- **JPaper の workflow は `.github/workflows/` に置く**（node-checks・pr-checks・self-test）。repo の Actions を有効にする（`gh api --method PUT repos/{owner}/{repo}/actions/permissions -F enabled=true`。`setup-github-repo.sh` は無効化を飛ばすだけで、有効にはしない）。private のうちに有効にすると PR ごとに private の無料枠を使うので、public に切り替えるときに有効にする。
- **`scripts/setup-github-repo.sh` は public repo では Actions を止めない**。private repo では従来どおり既定で止め、`--enable-actions` で止めない。repo の公開状態を読めなかったときは private として扱う。
- **merge の判断の基準はローカル検査のまま**。`bash tests/run-tests.sh`・`scripts/check-pr.sh`・`pnpm test` を merge 前に通す決まりは変えない。CI は同じ検査を別の環境（Linux。self-test は macOS でも）でもう一度走らせる確認として使う。[AI の merge 権限 ADR](./20260918-adopt-ai-merge-authority.md) の AUTO / HUMAN の条件は変えない。CI が red のときは、原因を確かめてから merge を判断する。
- **部分 supersede**: 20260901 の置換された条項＝決定 1（workflow を `workflows-disabled/` に置く）と、決定 2 のうち「既定で Actions を無効化する」を public repo に適用する部分／存続する条項＝private repo での既定オフ、決定 3（merge の判断はローカル検査）、required status checks を Actions 無効のまま設定しない注意。

# Consequences
- 良い面: PR ごとに型・テスト・ビルド・規約の検査が Linux と macOS で走り、ローカルで見落とした環境差（bash 3.2 と Linux の違いなど）を拾える。外の貢献者の PR も同じ検査を通る。
- 受け入れたトレードオフ:
  - repo を private に戻すと、20260901 の理由が再び当てはまる。そのときは `scripts/setup-github-repo.sh` を実行すれば Actions は止まるが、workflow は `.github/workflows/` に残る。
  - CI の結果は merge の必須条件にしていない（branch protection・required status checks は設定しない）。必須にするかは、CI が実際に走った実績を見てから別に決める。
