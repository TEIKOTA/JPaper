# 論文テンプレート別 front matter 命令表（JPaper タイトル認識・著者保護用）

調査日: 2026-10-08（#337）。実装の正本は `src/tools/frontmatter.ts`、決定は [前付けの型の表 ADR](../adr/20261011-drive-frontmatter-by-template-profile-table.md)。この文書は調査の記録で、表に入れていない型・命令も含む。

## 凡例

- **前/本**: タイトル命令の置き場所。前=前文（`\begin{document}` より前）、本=本文、両=どちらでも動く（公式サンプルの置き場所を太字）。
- **組む位置**: タイトルブロックが実際に組版される場所。「即時」= 命令そのものがその場で組む（格納しない）。
- **保護**: 原文保持（訳さない）すべき命令。`\author{…}` 内のスイッチ（`\And` `\name` 等）は `\author` ごと保護すれば済むので「内」と付記。
- 根拠の略号（ダウンロード元は末尾「根拠ソース」）: `L:`=ローカル arXiv ソース `article/<id>/.run/source/…`、`T:`=取得した公式テンプレート（取得元は末尾「根拠ソース」）、`M:`=記憶ベース（未検証・要確認）。
- ⚠ = 不確実／版依存。

---

## 表A: ML/AI 会議テンプレート

| テンプレート | タイトル命令 | タイトルと誤認してはならない命令 | 組む位置 / 前・本 | 著者・所属（保護対象） | ラッパ | 要旨 | 根拠 |
|---|---|---|---|---|---|---|---|
| **ICML** `icml20XX.sty`（2023/2025/2026 確認） | `\icmltitle{…}`（引数1、`\long`） | `\icmltitlerunning{…}`（**前文**、走行ヘッダ。未指定なら `\icmltitle` が流用される） | **即時**（`\icmltitle` 自体が組む）/ 本（`\twocolumn[` の中） | `\begin{icmlauthorlist}…\end{icmlauthorlist}`、`\icmlauthor{名前}{aff鍵,equal}`、`\icmlsetsymbol{equal}{*}`、`\icmlaffiliation{鍵}{所属}`、`\icmlcorrespondingauthor{名前}{email}`、`\icmlkeywords{…}`、`\printAffiliationsAndNotice{\icmlEqualContribution}`（`]` の外、2026 は空でも必須） | `\twocolumn[ \icmltitle … \vskip 0.3in ]` | `\begin{abstract}`（`]` の後） | L:2302.03519/main.tex, icml2023.sty:358-361,437; T:icml2025/example_paper.tex, icml2026/icml2026.sty:353-391,426-519 |
| ICML ≤2016 ⚠ | 同上 | 同上 | 同上 | `\icmlauthor{名前}{email}` + `\icmladdress{…}`（**第2引数の意味が現行と違う**）。2023 sty では `\icmladdress` は廃止スタブ | 同上 | 同上 | L:icml2023.sty:552-553（廃止スタブ）, M |
| **AISTATS** `aistats20XX.sty` | `\aistatstitle{…}` | `\runningtitle{…}`, `\runningauthor{…}`（前文、通常コメントアウト） | **即時** / 本（`\twocolumn[` 内） | `\aistatsauthor{A \And B}`, `\aistatsaddress{I1 \And I2}` | `\twocolumn[ \aistatstitle … \aistatsaddress{…} ]` | env | T:aistats2025/sample_paper.tex:33-44, aistats2025.sty:149,219,326。補遺 `supplement.tex` は `\onecolumn` 後に **2 回目の `\aistatstitle`** |
| **NeurIPS** `neurips_20XX.sty`（2019/2022/2025） | `\title{…}` | なし | `\maketitle` / **前** | `\author{… \thanks{} \\ 所属 \\ \texttt{email} \And … \AND …}` | なし | env | L:1810.11953/failing_loudly.tex, 2202.06985/main.tex; T:neurips2025/neurips_2025.tex:59-106 |
| **ICLR** `iclr20XX_conference.sty` | `\title{…}`（`\\` 改行可） | なし | `\maketitle` / **前** | `\author{…\thanks{}…\And…\AND…}`。`\iclrfinalcopy` | なし | env | L:2209.04836/iclr2023_conference.tex; T:iclr2025_conference.tex。L:2601.20627 の `main.sty` は ICLR 派生の改名版 |
| **COLM** `colm20XX_conference.sty` | `\title{…}` | なし | `\maketitle` / 前 | ICLR と同形 `\author{…\thanks…\And…\AND…}`、`\colmfinalcopy` | なし | env | Overleaf COLM 2025 template（WebFetch） |
| **TMLR** `tmlr.sty` | `\title{…}` | なし（`\def\month` `\def\year` `\def\openreview` は前文メタ） | `\maketitle` / 前 | `\author{\name A \email a@x \\ \addr 所属 \AND \name B …}`（**jmlr 流のスイッチ、波括弧なし**） | なし | env | T:tmlr.tex:16-50 (JmlrOrg/tmlr-style-file main.tex) |
| **ACL/EMNLP/NAACL** `acl.sty` | `\title{…}` | なし | `\maketitle` / 前 | `\author{First \\ 所属 \\ \texttt{email} \\\And Second …}`、`\AND`、新形式 `\textbf{名}\textsuperscript{1}…\\ \textsuperscript{1}所属` | なし | env | T:acl_latex.tex:40-109 (acl-org/acl-style-files) |
| **COLING 2025** `coling.sty` ⚠ | `\title` | なし | `\maketitle` / 前 | ACL と同形（`\And` `\AND` `\and`） | なし | env | WebSearch（Overleaf "Instructions for COLING 2025"）。旧 `coling2020.sty`、`lrec-coling2024.sty` も流通 |
| **CVPR/ICCV/WACV** `cvpr.sty` | `\title{…}`（`\confName` 等マクロを含みがち） | なし。補遺用 `\maketitlesupplementary` | `\maketitle` / **前**（`\def\paperID` `\def\confName` `\def\confYear` も前文） | `\author{First\\Inst\\{\tt\small email} \and Second…}` | 2025+: `\maketitle` 直後の `\begin{strip}…\end{strip}`（teaser）。旧版の慣用: `\twocolumn[{\renewcommand\twocolumn[1][]{#1}\maketitle …teaser…}]` ⚠M | `\input{sec/0_abstract}` 内 env | T:cvpr-org/author-kit main.tex:25-50, fig/teaser.tex, cvpr.sty:476-479 |
| **ECCV** `eccv.sty`+`llncs.cls` | `\title{…}` | `\titlerunning{…}` | `\maketitle` / **本** | `\author{A\inst{1}\orcidlink{…} \and …}`, `\authorrunning`, `\institute{… \and …}` 内 `\email` | なし | env + `\keywords` | T:paper-favaro/paper-template main.tex:52-84 |
| **AAAI** `aaai20XX.sty` | `\title{…}` | 旧版（≤aaai21 頃）の `\pdfinfo{/Title (…) /Author (…)}` ⚠（2026 sty は `\pdfinfo` を握り潰す） | `\maketitle`（内部で `\twocolumn[\@maketitle]`、実行後 `\let\maketitle\relax`）/ **前** | `\author{名\textsuperscript{\rm 1}\equalcontrib, …}`、`\affiliations{…}`（**1 引数命令**）、`\nocopyright` | （`\maketitle` 内部） | env | L:2510.17897/aaai-submission-latex-2026.tex:116-170, aaai2026.sty:8-12,53-126。**テンプレ例の `\title` が `\iffalse…\fi` 内に 2 個残る** |
| **IJCAI** `ijcai2X.sty` | `\title{…}` | 旧版 `\pdfinfo` ⚠M | `\maketitle` / 前 | `\author{名$^1$ \and … \affiliations $^1$所属\\ \emails a@x}`（**`\affiliations` `\emails` は `\author` 内のスイッチ**＝AAAI と同名異義） | なし | env | ax:2402.01446/ijcai24.tex:42-58 |
| **UAI** `uai2025.cls`/`uai2026.cls`（クラス） | `\title{…}` | なし | `\maketitle` / 前 | authblk 形 `\author[1]{\href{mailto:…}{名}~\thanks{}}`, `\affil[1]{%…}` | なし | env | ax:2408.06710/main.tex:56-78, 2603.04473/uai2026-template.tex |
| **PMLR / COLT / MLHC / MIDL** `jmlr.cls`（`[pmlr]`） | `\title[短縮]{本題 \titlebreak …}` | 任意引数 `[短縮]`（走行用） | `\maketitle` / **前** | `\author[短縮]{\Name{A\nametag{\thanks{}}} \Email{a@x} \and \Name{B}\\ \addr 所属 \AND …}`、`\editor{…}`、`\jmlrvolume` `\jmlryear` `\jmlrworkshop` `\jmlrproceedings`。COLT の `\coltauthor` ⚠M | なし | env + `\begin{keywords}` | T:jmlr/pmlr-sample.tex:30-91, jmlr.dtx:3408-3894 |
| **JMLR** `jmlr2e.sty` | `\title{…}` | `\ShortHeadings{短縮題}{著者}`、`\jmlrheading{vol}{yr}{pp}{sub}{pub}{id}{著者}` | `\maketitle` / 両（ローカル例は前文） | `\author{\name A \email a@x \\ \addr 所属 \AND …}`（**スイッチ、波括弧なし**）、`\editor{…}`、`\firstpageno{}` | なし | env + `\begin{keywords}` | L:2011.03395/main.tex:47-96, jmlr2e.sty:230-272 |

## 表B: 出版社・ジャーナル・物理/生物系

| テンプレート | タイトル命令 | 誤認してはならない命令 | 組む位置 / 前・本 | 著者・所属（保護対象） | ラッパ | 要旨 | 根拠 |
|---|---|---|---|---|---|---|---|
| **IEEEtran.cls**（conf/journal/compsoc） | `\title{…}` | `\markboth{誌名}{著者: 短縮題}`（走行ヘッダ）、`\IEEEspecialpapernotice` | `\maketitle` / **本**。peerreview 用 `\IEEEpeerreviewmaketitle`（組まない） | conf: `\author{\IEEEauthorblockN{名}\IEEEauthorblockA{所属\\email} \and …}`, `\IEEEauthorrefmark{1}`。journal: `\author{名,~\IEEEmembership{Member,~IEEE}, …\thanks{…}}`, compsoc: `\IEEEcompsocitemizethanks{\IEEEcompsocthanksitem …}` | compsoc: `\IEEEtitleabstractindextext{\begin{abstract}…\end{abstract}\begin{IEEEkeywords}…}` を `\maketitle` **前**に格納、後で `\IEEEdisplaynontitleabstractindextext` | env（conf は `\maketitle` 後、compsoc は前で格納） | T:CTAN IEEEtran bare_conf.tex:315-399, bare_jrnl_compsoc.tex:370-509 |
| **Springer LNCS** `llncs.cls`（MICCAI 等） | `\title{…}`（`\thanks` 可）、`\subtitle{…}` | `\titlerunning{…}`, `\toctitle{…}`, `\tocauthor{…}` | `\maketitle` / **本** | `\author{A\inst{1}\orcidID{…} \and B\inst{2}}`（`\orcidlink` もよく使う）, `\authorrunning{…}`, `\institute{所属 \\ \email{…} \and 所属2}` | なし | env、`\keywords{A \and B}` は abstract 内 | L:2605.18329, 2605.26292, 2606.20913, 2606.22649, 2607.28007 の main.tex; T:CTAN llncs/llncsdoc.tex:87-220 |
| **Springer svjour3** | `\title{…\thanks{}}`, `\subtitle{…}` | `\titlerunning{…}`, `\authorrunning{…}` | `\maketitle` / **本** | `\author{A \and B}`, `\institute{F. Author \at 住所 \\ \email{…} \and S. Author \at …}`, `\date{Received: date / Accepted: date}` | なし | env + `\keywords{A \and B}` | gh: jkitchin/jmax texmf/doc/latex/svjour3/template.tex:43-98 |
| **Springer Nature** `sn-jnl.cls` | `\title[短縮]{本題}` | 任意引数 `[短縮]` | `\maketitle`（abstract/keywords の**後**）/ **本** | `\author*[1,2]{\fnm{名} \sur{姓}}\email{…}`（**星付き**＝責任著者）、`\equalcont{…}`、`\affil*[1]{\orgdiv{} \orgname{} \orgaddress{\street{} \city{} \postcode{} \state{} \country{}}}` | なし | **命令形 `\abstract{…}`**（env ではない）+ `\keywords{}` + `\pacs[…]{}`、いずれも `\maketitle` 前 | T:springernature sn-article-template/sn-article.tex:91-142 |
| **Elsevier** `elsarticle.cls` | `\title{…}`（**連結式**: `\g@addto@macro\@title`、複数回で追記される）、内部に `\tnoteref{}` | `\journal{誌名}`（前文） | **`\end{frontmatter}`**（`\newenvironment{frontmatter}{}{\maketitle}`）/ 本 | `\author[aff]{名\corref{cor1}\fnref{fn1}}`, `\ead{…}`, `\ead[url]{…}`, `\affiliation[label]{organization={},addressline={},city={},postcode={},state={},country={}}`（新、key=val）, 旧 `\address[label]{…}`, `\cortext[cor1]{…}`, `\fntext[fn1]{…}`, `\tnotetext[t1]{…}` | `\begin{frontmatter}…\end{frontmatter}` | env（frontmatter 内で `\absbox` に**格納**）、`\begin{keyword} A \sep B`、`\begin{highlights}`、`\begin{graphicalabstract}` | L:1902.06543/medima-template.tex:85-129, 2410.16038/…Scenarios.tex:31-64; T:CTAN elsarticle.dtx:193-259,318,656,729,1430 |
| **Elsevier CAS** `cas-sc.cls`/`cas-dc.cls` | `\title [mode = title]{…}`（**key=val 任意引数、命令と `[` の間に空白**）、`\tnotemark[1]` | `\shorttitle{…}`, `\shortauthors{…}` | `\maketitle`（abstract/highlights/keywords の**後**）/ 本 | `\author[1]{名}[orcid=…,type=editor,…]`（**後置の任意引数**）, `\cormark[1]`, `\fnmark[1]`, `\ead{}`, `\ead[url]{}`, `\credit{}`, `\affiliation[1]{organization={},…}`, `\cortext[1]{}`, `\fntext[1]{}` | なし | env（`\maketitle` 前）, `\begin{highlights}`, `\begin{keywords}` | T:CTAN els-cas-templates/cas-dc-template.tex:44-165 |
| **ACM** `acmart.cls` | `\title[短縮]{本題}`, `\subtitle{}`, `\titlenote{}`, `\translatedtitle{lang}{…}` | 任意引数 `[短縮]`、`\renewcommand{\shortauthors}{…}`、`\acmConference[短]{名}{日}{場所}`、`\acmBooktitle{…}`、`\acmJournal{}` | `\maketitle` / 本（サンプル）・前でも可 | `\author{名}`, `\authornote{}`, `\authornotemark[]`, `\email{}`, `\orcid{}`, `\affiliation{\institution{} \department{} \city{} \state{} \country{}}`（`\streetaddress` `\postcode` は警告付き廃止）, `\additionalaffiliation{}`, `\thanks` | `\begin{teaserfigure}`（`\maketitle` 前） | **env を `\maketitle` より前に置く（格納）**、`\begin{CCSXML}`、`\ccsdesc[500]{…}`、`\keywords{}`、`\received{}` | T:CTAN acmart.dtx:538-542,1059,5172-5747,6609 |
| **APS/AIP** `revtex4-2` | `\title[短縮]{本題}`（`\thanks` 可） | `\preprint{番号}`、任意引数 | `\maketitle` / **本** | `\author{名}` → 直後の `\affiliation{…}` が直前の著者群に掛かる、`\email[]{}`, `\homepage[]{}`, `\altaffiliation[]{}`, `\noaffiliation`, `\collaboration{}`, `\date{\today}` | なし | **env を `\maketitle` より前に置く（必須）**、`\pacs{}`, `\keywords{}` | T:CTAN revtex sample/aps/apstemplate.tex:33-79, auguide4-2.tex:614, ltxfront.dtx:1033,1347-1872 |
| **IOP** `iopart.cls` | `\title[短縮]{本題}` **即時組版**。代替: `\paper`（=`\title`）, `\article[短縮]{種別}{題}`, `\review`, `\letter{題}`, `\topical`, `\comment`, `\rapid`, `\note`, `\prelim` | 任意引数（`\markboth` に入る） | **即時** / 本。**`\maketitle` は `\newpage` にすぎない**（タイトルを組まない） | `\author[cor1]{名}`（即時）, `\address{…}`（即時）, `\ead{…}`, `\eads{\mailto{}…}`, `\submitto{\JPA}`, `\ams{}`, `\pacs{}` | なし | env（即時）、`\noindent{\it Keywords\/}:` 平文 | ax:1404.7439/IOPLaTeX.tex:51-86, iopart.cls:95-354; ax:2407.00378/Main.tex |
| **MDPI** `Definitions/mdpi.cls` | **`\Title{…}`**（大文字 T） | `\TitleCitation{…}`, `\AuthorCitation{}`, `\AuthorNames{}` | **`\AfterEndPreamble{\maketitle …}`＝`\begin{document}` 直後に自動**。ソースに `\maketitle` は無い / **前** | `\Author{名 $^{1,\dagger}$\orcidA{}, …}`, `\newcommand{\orcidauthorA}{…}`, `\address{%$^{1}$ \quad 所属…}`, `\corres{…}`, `\firstnote{}`, `\secondnote{}`, `\datereceived{}` 等 | なし | **命令形 `\abstract{…}`**（前文）, `\keyword{a; b}` | gh: MSUcourses/…/MDPI_template/template.tex:5-161, Definitions/mdpi.cls:415-548,1085-1101 |
| **Nature** `nature.cls`（naturemag は .bst） | `\title{…}` | なし | `\maketitle` / 前 | `\author{A$^{1,2}$, B$^2$ \& C$^2$}`、`\begin{affiliations}\item …\end{affiliations}`（**`\maketitle` の後**、本文 env） | なし | env | T:CTAN nature/nature-template.tex:13-30 |
| Nature 派生 `naturep.cls`（ローカル） | `\title{\begin{flushleft}{\begin{spacing}{1} 題 \end{spacing}}\end{flushleft}}` | なし | `\maketitle`（**`\input` 先の `sections/0-cover_page.tex` 内**） | **著者は `\author` ではなく `\maketitle` 後の平文段落**、`\begin{affiliations}` | なし | 平文 `\textbf{…}` | L:2308.15474/main.tex:71, sections/0-cover_page.tex, style/naturep.cls:58-67 |
| **PNAS** `pnas-new.cls` | `\title{…}` | `\leadauthor{姓}`（走行フッタ） | `\maketitle` / 前（メタは全部前文） | `\author[a,c,1]{名}`, `\affil[a]{…}`, `\equalauthors{}`, `\correspondingauthor{}`, `\authorcontributions{}`, `\authordeclaration{}`, `\templatetype{}`, `\dates{}`, `\doi{}` | なし | **env を前文に置く（格納）**、`\significancestatement{…}`（訳すべき本文）, `\keywords{A $\mid$ B}` | gh: eddelbuettel/pinp local/pnas-20180506/PNAS-template-main.tex:1-46 |
| Oxford Bioinformatics `bioinfo.cls` ⚠M | `\title[短縮]{本題}` | 任意引数 | `\maketitle`（abstract 後）/ 本 | `\author[1,$\ast$]{}`, `\address{$^{1}$…}`, `\corresp{}`, `\history{}`, `\editor{}` | なし | 命令形 `\abstract{\textbf{Motivation:}…}` | M（未検証） |
| PLOS（クラス無し） ⚠M | **`\title` 無し**。`\begin{flushleft}{\Large\textbf\newline{題}}\newline … 著者 … \end{flushleft}` | — | 即時（平文） | 平文＋`\textsuperscript` | なし | 平文 `\section*{Abstract}` | M（plos_latex_template.tex） |
| Science `scicite` ⚠M | `\title{…}` | なし | `\maketitle` / 前 | `\author{A$^{1\ast}$\\ \normalsize{$^{1}$所属}\\ \normalsize{$^\ast$E-mail}}`, `\date{}` | なし | `\begin{sciabstract}` | M |

## 表C: 汎用・arXiv 系

| テンプレート | タイトル命令 | 誤認してはならない命令 | 組む位置 / 前・本 | 著者・所属（保護対象） | ラッパ | 要旨 | 根拠 |
|---|---|---|---|---|---|---|---|
| LaTeX 標準 `article` | `\title{…}`（`\thanks`, `\\` 可） | `\date{…}` | `\maketitle`（実行後 `\global\let\maketitle\relax`、`\@title` も空にする） / 両 | `\author{A \and B}`, `\thanks{}` | 手組み `\begin{titlepage}…\end{titlepage}`（`\title` 無しのことあり） | env | L:2407.12996/arxiv.tex:55-76 |
| **arxiv.sty**（kourgeorge/arxiv-style） | `\title{…}` | **`\renewcommand{\shorttitle}{…}`**（走行ヘッダ。既定は `\@title`）、`\hypersetup{pdftitle={…}}` | `\maketitle` / 前 | `\author{\href{orcid}{\includegraphics…}\hspace{1mm}名\thanks{} \\ 所属 \\ \texttt{email} \And …}` または authblk 形 | なし | env + `\keywords{A \and B}`（abstract 後） | T:kourgeorge/arxiv-style template.tex:19-102, arxiv.sty:31-45,228-232 |
| arxiv 派生 `arxiv_style.sty`（ローカル） | `\title{\textbf{…}}` | — | `\maketitle` / **本**（`\begin{document}` 後、`\maketitle` 前） | `\author[1,2,*]{名}`, `\affil[1]{…}`, `\affil[*]{Equal contribution…}`, `\date{}` | なし | env | L:2507.17845/arxiv.tex:75-133 |
| 派生 `preprint.sty`（ローカル） | `\title{…}` | — | `\maketitle` / 前 | authblk `\author[1,2\thanks{}]{名}`, `\affil[1]{…}` | **`\twocolumn[ \begin{@twocolumnfalse} \maketitle \begin{abstract}…\end{abstract} \keywords{…} \end{@twocolumnfalse} ]`** | env（ラッパ内） | L:2306.15350/main.tex:88-170 |
| `authblk` パッケージ | — | `\Authfont` `\Affilfont` `\Authsep` `\Authand` `\Authands`（前文設定） | （`\maketitle`） | `\author[1,2]{名}`, `\affil[1]{…}`, `\affil[*]{…}` | — | — | T:CTAN preprint/authblk.dtx; L:2306.15350, 2507.17845 |
| `amsart` ⚠M | `\title[短縮]{本題}` | 任意引数、`\subjclass[2020]{}` | `\maketitle` / 本 | `\author{}` → `\address{}`, `\curraddr{}`, `\email{}`, `\urladdr{}`, `\thanks{}`, `\dedicatory{}`, `\date{}` | なし | **env を `\maketitle` より前（格納）**、`\keywords{}` | M |
| KOMA `scrartcl` ⚠M | `\title{}`, `\subtitle{}` | `\titlehead{}`, `\subject{}`, `\publishers{}`, `\dedication{}` | `\maketitle` | `\author{}` | — | env | M |

---

## ローカル実例（`article/*/.run/source`）とテンプレの対応

| arXiv id | テンプレ | 特徴（実装上の注意） |
|---|---|---|
| 1810.11953 | neurips2019 | 標準 |
| 1902.06543 | elsarticle（medima） | frontmatter 内 `\title`, `\address[1]{}`, `\ead`, `\corref` |
| 2011.03395 | jmlr2e | `\title{\vspace{-.5em}…}`、`\ShortHeadings`、`\name`/`\email` スイッチ、`\footnotemark[\value{footnote}]` |
| 2202.06985 | neurips_2022 | 標準 |
| 2209.04836 | iclr2023_conference | 標準 |
| 2302.03519 | icml2023 | `\icmltitlerunning`（前文）＋`\twocolumn[\icmltitle…]` |
| 2306.15350 | 自作 preprint.sty + authblk | `\twocolumn[\begin{@twocolumnfalse}\maketitle…]` |
| 2308.15474 | naturep.cls | `\title` に env、`\maketitle` は `\input` 先、著者は平文 |
| 2407.12996 | article + fullpage | `\author` 内に所属を平文で列挙、`\footnote` |
| 2410.16038 | elsarticle | `\affiliation[label1]{…}` |
| 2507.17845 | arxiv_style.sty | 本文に `\title`、authblk |
| 2510.17897 | aaai2026 | `\affiliations{}`、`\iffalse` 内のダミー `\title` ×2 |
| 2601.20627 | main.sty（ICLR 派生） | `\title{\diverse: …}`（マクロ始まり） |
| 2605.18329 | llncs（MICCAI） | `\let\lncsemail\email \renewcommand{\email}…`（前文で再定義）, `\orcidlink` |
| 2605.26292 / 2606.20913 / 2606.22649 / 2607.28007 | llncs（MICCAI） | `\titlerunning`, `\authorrunning`, 2607.28007 は匿名版と実名版の `\author` が 2 組 |

---

## (a) 実装に入れた範囲

`src/tools/frontmatter.ts` の型の表に入れたのは次の部分だけ。ほかの行は調査の記録として残す。

- 既定の型: タイトルは `\title`（`[短縮]` を読み飛ばす）、組む位置は `\maketitle`・`\end{frontmatter}`。
- ICML（`icml\d{4}` か `\icmltitle`）: タイトルは `\icmltitle`、その場で組む。
- AISTATS（`aistats\d{4}` か `\aistatstitle`）: タイトルは `\aistatstitle`、その場で組む。
- elsarticle: `\title` を連結する（2 つ以上あれば訳すタイトルは見つからない扱い）。
- iopart: `\title` がその場で組み、`\maketitle` は組む位置にしない。
- MDPI（`mdpi` クラス）: タイトルは `\Title`（前文）。
- 原文のまま残す命令と環境（全型共通。必須引数の数つき）: 表A〜C の「著者・所属」と注記のうち、引数を取る命令。キーワード（`\keywords`・`keyword` 環境・`\icmlkeywords`）と PNAS の `\significancestatement` は訳すので入れない。`\and`・jmlr2e の `\name`/`\email` のような引数を取らない切り替えは、`\author` ごと残るので入れない。

走行タイトル（`\icmltitlerunning`・`\titlerunning`・`\shorttitle` など）は別の綴りなので、タイトルの命令に入れなければ数えない。

対訳 PDF（`src/tools/bilingual-latex.ts`）は、節ごとに、その場で組む命令（ICML・AISTATS・iopart）を中身に含む最初の `\twocolumn[…]` を外して中身を段の中で組む。ICML の型の論文には、版面の検査（`icml\d{4}` のときだけ）・頁番号・段をまたぐ所属の番号・連絡先の手当てを前文に足す（issue #330）。

## (b) 落とし穴

1. **後勝ち vs 連結**: 通常の `\title` は後勝ちだが elsarticle は `\g@addto@macro` で**連結**（elsarticle.dtx:193）。「最後の `\title` を拾う」規則は elsarticle で 2 個以上あると誤る。
2. **偽の `\title`**: AAAI テンプレは `\iffalse … \fi` 内にダミーの `\title` を 2 つ残す（2510.17897）。コメント除去だけでは足りず、`\iffalse…\fi`（と `\if0`、`comment` 環境）も除外が必要。2607.28007 のように匿名版／実名版 `\author` が 2 組並ぶ例もある。
3. **即時組版と格納の違い**: `\icmltitle` `\aistatstitle` iopart の `\title`/`\author`/`\address`/abstract はその場で組む。iopart の `\maketitle` は `\newpage` にすぎず、ここに対訳タイトルブロックを差し込むとタイトルが二重になる。MDPI はソースに `\maketitle` が無く、`\AfterEndPreamble` で自動的に組む。
4. **`\maketitle` は 1 回きり**: article/AAAI/MDPI は実行後に `\let\maketitle\relax` し、article は `\@title` も空にする。対訳ブロックを「左右で `\maketitle` を 2 回呼ぶ」形で作ると、2 回目はエラーも出さずに空になる。AAAI の `\maketitle` は内部で `\twocolumn[...]` を使う。
5. **abstract を `\maketitle` より前に置いて格納する系**: acmart、revtex（必須）、amsart、PNAS（前文）、CAS、elsarticle（frontmatter 内）、IEEE compsoc（`\IEEEtitleabstractindextext`）、sn-jnl/MDPI（命令形 `\abstract{}`）。`\maketitle` の位置でタイトルブロックを差し替えると、要旨もそこで組まれる点に注意する。sn-jnl/MDPI の `\abstract{…}` は環境ではなく命令なので、「abstract 環境を訳す」処理では拾えない。
6. **タイトル中のマクロや体裁命令**: `\title{\papertitle}`、CVPR の `\confName`、`\title{\diverse: …}`（2601.20627）、`\title{\textbf{…}}`、`\title{\vspace{-.5em}…}`、`\title{\begin{flushleft}{\begin{spacing}{1}…}}`（naturep）、`\\`、`\thanks{}`、`\tnoteref{}`、`\titlebreak`（jmlr.cls）、`\texorpdfstring`。「本題に文字が残るか」の判定は、環境・`\vspace` 等の体裁命令も除いてから行う。
7. **同名異義**:
   - `\affiliations`: AAAI では 1 引数の命令、IJCAI では `\author` 内のスイッチ
   - `\email`: llncs/acmart では命令、jmlr2e/tmlr では**波括弧なしのスイッチ**、revtex では `[opt]` 付き
   - `\abstract`: 環境のこともあれば命令のこともある
   - `\address`: elsarticle は `[label]{}` で格納、iopart はその場で組む、MDPI は格納
   - `\author` の任意引数: authblk/PNAS/elsarticle では所属ラベル、jmlr.cls/acmart では短縮名、iopart では `cor1`。sn-jnl は星付き、CAS は後置 `[orcid=…]`

   命令名から引数の仕様を読み取る処理は、プロファイルごとに変える。
8. **空白・改行を挟む引数**: `\title [mode = title]{…}`（CAS）、`\affiliations {`（AAAI 例）、`\author {`。命令と `[`/`{` の間の空白を許容する。
9. **走行タイトルの書式が `\cmd{…}` だけではない**: `\renewcommand{\shorttitle}{…}`（arxiv.sty。ここで `{\shorttitle}` が現れる）、`\markboth{}{}`、`\ShortHeadings{}{}`、`\hypersetup{pdftitle=…}`、旧 AAAI/IJCAI の `\pdfinfo{/Title (…)}`、`\title[短縮]{…}` の任意引数、`\icmltitlerunning`（前文）。「定義命令の直後の `\title` は拾わない」という既存規則は、`\renewcommand{\shorttitle}` にも適用する必要がある。
10. **前文での再定義**: `\let\lncsemail\email \renewcommand{\email}[1]{…}`（2605.18329）。`\newcommand`/`\let`/`\def` の直後にある front matter 命令名は、使用箇所として扱わない。
11. **ラッパの中のタイトル**:
    - ICML/AISTATS は `\twocolumn[…]` の中で組む
    - 汎用の `\twocolumn[\begin{@twocolumnfalse}\maketitle…\end{@twocolumnfalse}]`（2306.15350）では、`\maketitle` が任意引数の中にある。置換するときは `[`…`]` の釣り合いを保ち、置換文字列に `]` を含めるなら `{}` で包む
    - 旧 CVPR の慣用 `\twocolumn[{\renewcommand\twocolumn[1][]{#1}\maketitle …}]` も同じ扱い
    - CVPR 2025 以降は `\maketitle` 直後の `strip` 環境

    いまの `\twocolumn[` 置換は `\icmltitle` を含む場合に限っているが、`\maketitle` を含む `\twocolumn[` は別の経路でおかしくなりうる。
12. **版依存**:
    - ICML ≤2016 は `\icmlauthor{名}{email}`＋`\icmladdress`（第2引数の意味が違う）。2017 以降は `icmlauthorlist`＋`\icmlaffiliation`。2026 は `\printAffiliationsAndNotice{}` が必須
    - llncs の `\orcidID` は 2.20 以降
    - elsarticle の key=val 形 `\affiliation` は新しい版、それより前は `\address`
    - acmart の `\streetaddress`/`\postcode` は廃止警告付き
    - COLING は年ごとに sty 名が変わる（`coling2020` / `lrec-coling2024` / `coling`）
    - 会議の sty は改名した派生（`main.sty` = ICLR 派生、`preprint.sty`・`arxiv_style.sty` = arxiv.sty 派生）として頻繁に同梱される

    プロファイルの判定は sty 名の完全一致だけに頼らず、`\icmltitle` などの存在でも判定できるようにしておく。
13. **`\author` を使わない著者表記**: naturep（`\maketitle` 後の平文段落＋`affiliations` 環境）、PLOS（`\title` 自体が無い）、2407.12996（`\author` 内に所属を平文で書く）。`\author` を保護するだけでは著者が訳されてしまう。タイトル未検出時のフォールバック（対訳ブロックを作らない）も必要。
14. **`\input` 先のタイトル**: 2308.15474 では `\maketitle` が `sections/0-cover_page.tex` にある。インクルードを展開してから探索する。
15. **2 回目の title 命令**: AISTATS の補遺 `\onecolumn\aistatstitle{…: Supplementary Materials}`、CVPR の `\maketitlesupplementary`、`\appendix` 後の `\onecolumn` 再タイトル。「最初の組む位置」に限定すれば回避できる。
16. **キーワード類の扱いは設計判断として未決**: `\icmlkeywords`（PDF メタのみ）、`\keywords{}`、`\begin{keyword}`、PNAS の `\significancestatement`（訳すべき本文）、`\thanks`/`\fntext`/`\cortext` 内の散文（例: "Equal contribution"）。保護するか訳すかを決める必要がある。

## 根拠ソース（取得元）

- ローカル: `article/<id>/.run/source/`（上表）。
- ICML 2025/2026: https://media.icml.cc/Conferences/ICML2025/Styles/icml2025.zip, https://media.icml.cc/Conferences/ICML2026/Styles/icml2026.zip
- NeurIPS 2025: https://media.neurips.cc/Conferences/NeurIPS2025/Styles.zip
- AISTATS 2025: https://aistats.org/aistats2025/AISTATS2025PaperPack.zip
- ICLR 2025: https://github.com/ICLR/Master-Template (iclr2025/iclr2025_conference.tex)
- ACL: https://github.com/acl-org/acl-style-files (acl_latex.tex)
- CVPR: https://github.com/cvpr-org/author-kit (main.tex, fig/teaser.tex, cvpr.sty)
- ECCV: https://github.com/paolo-favaro/paper-template
- TMLR: https://github.com/JmlrOrg/tmlr-style-file (main.tex)
- arxiv.sty: https://github.com/kourgeorge/arxiv-style
- COLM 2025: https://www.overleaf.com/latex/templates/colm-2025-template/cxjxqpcxnvzh
- COLING 2025: https://www.overleaf.com/latex/templates/instructions-for-coling-2025-proceedings/hfhcytgpqmzf（WebSearch 要約のみ ⚠）
- IJCAI-24: arXiv e-print 2402.01446（ijcai24.tex）
- UAI 2025/2026: arXiv e-print 2408.06710, 2603.04473
- IOP iopart: arXiv e-print 1404.7439（iopart.cls, IOPLaTeX.tex）, 2407.00378
- CTAN: llncs, IEEEtran, elsarticle, els-cas-templates, acmart, revtex, jmlr, nature, preprint(authblk)
- Springer Nature: https://media.springernature.com/full/springer-cms/rest/v1/content/18782940/data/v12（sn-article.tex）
- svjour3: https://github.com/jkitchin/jmax texmf/doc/latex/svjour3/template.tex
- MDPI: https://github.com/MSUcourses/Data-Analysis-with-Python LaTeX/Examples/MDPI_template（template.tex, Definitions/mdpi.cls）
- PNAS: https://github.com/eddelbuettel/pinp local/pnas-20180506/PNAS-template-main.tex（2018 版 ⚠）
- 記憶ベース（M, 未検証）: ICML ≤2016, CVPR 旧 teaser 慣用, COLT `\coltauthor`, bioinfo.cls, PLOS, Science, amsart, KOMA, 旧 AAAI/IJCAI `\pdfinfo`
