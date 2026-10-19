# JPaper の子のコンテナの image（agent-box-jpaper）

JPaper の委譲で使う子のコンテナの image。共通の image `agent-box:latest`（`docker/agent/`。テンプレートの正本）に、JPaper の検証に要るものを足す（#452）。agent-box の運用全体は [`docs/process/agent-containers.md`](../../docs/process/agent-containers.md)。この README は JPaper 固有の部分だけを持つ（`docs/` はテンプレートから写るため、repo 固有の手順はここに置く）。

## 足すもの

| もの | 版・入れ方 | 使う所 |
|---|---|---|
| pnpm | `package.json` の `packageManager` と同じ版（Dockerfile の `PNPM_VERSION`）を `npm install -g` | `pnpm install`・`typecheck`・`test` |
| TeX Live | ホストと同じ 2025 の凍結版（`tlnet-final`）を `install-tl` の `scheme-basic` で入れ、collection を `tlmgr` で足す。文書・ソースは入れない | 組版（`latexmk -lualatex`・luatexja・paracol）と、`pdflatex` で組む対訳のテスト |
| poppler-utils | Debian の apt | PDF の取り込み（`pdftotext`・`pdfinfo`・`pdftoppm`）と対訳のテスト |

TeX の collection: latexrecommended・latexextra・fontsrecommended・langjapanese・luatex・mathscience・bibtexextra・publishers・pictures・plaingeneric と、パッケージ latexmk・newtx・newpx・libertine・inconsolata・fontaxes。ホストは scheme-full なので、collection-fontsextra などに入るフォントを使う論文は、ホストでは組めてもコンテナでは組めないことがある。足りないものは Dockerfile の `tlmgr install` に足す。

子は非 root・`--read-only` で動くので、TeX の可変領域（luaotfload・luatexja のキャッシュ）は `TEXMFVAR=/cache/texlive/texmf-var`、pnpm の store は `/cache/pnpm/store` を向く（`/cache` は repo ごとの volume で、同じ repo のセッションが共有する）。フォント名のデータベースは image を作るときに `TEXMFSYSVAR` へ作っておく。

## 作り方

先に共通の image を作っておく（`docker build -t agent-box:latest docker/agent`）。そのうえで repo の root で:

```
docker build -t agent-box-jpaper:latest docker/jpaper
```

共通の image を作り直したら、この image も作り直す。版を上げるときは Dockerfile の ARG だけを変える。

## 子の起動

`start` に `--image agent-box-jpaper:latest` を付ける（付けないと共通の image で起動し、pnpm も TeX も無い）。

```
scripts/agent-box.sh start impl-123 --branch feat/123-x --image agent-box-jpaper:latest --prompt-file <依頼>
```

`resume` は `start` のときの image を使う。
