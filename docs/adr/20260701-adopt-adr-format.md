# 2026/07/01 ADRフォーマットの採用

# Status
- accepted

# Situation
- プロジェクトにおいて、過去の意思決定の背景や動機が暗黙知となり、新しく参画したメンバーが過去の決定を理解しにくいという課題がある。
- 非同期コミュニケーションでの意思決定において、前提条件や背景の認識合わせに時間がかかることがある。

# Context
- 上記の課題を解決するため、意思決定の理由と背景を記録・追跡可能な形にする必要がある。
- ADRの導入にあたっては、包括的なドキュメントではなく、小さくモジュール化されたドキュメントとし、仕様書としてではなく決定のログとして扱うことが重要とされている。
- チームへスムーズに展開するため、シンプルで必要十分な項目を持つフォーマットが求められている。

# Material for decision
- 参考記事: ZOZO TECH BLOG 「ZOZOFITにおけるADRを利用した意思決定を残す文化作り」(2023-03-17)
- ベースとなるテンプレート: https://github.com/joelparkerhenderson/architecture-decision-record/tree/main/locales/ja/%E3%83%86%E3%83%B3%E3%83%97%E3%83%AC%E3%83%BC%E3%83%88/Michael%20Nygard%20%E3%81%AB%E3%82%88%E3%82%8B%E6%84%8F%E6%80%9D%E6%B1%BA%E5%AE%9A%E8%A8%98%E9%8C%B2%E3%83%86%E3%83%B3%E3%83%97%E3%83%AC%E3%83%BC%E3%83%88

# Decision
- 参考記事で言及されている、以下のセクションを持つシンプルなADRフォーマットを採用し、今後の意思決定の記録に使用する。
  - **Status**: 意思決定のステータス (proposed/accepted/rejected/deprecated/superseded)
  - **Situation**: 決定時のビジネスにおける制約や会社、チームの状況
  - **Context**: 決定が必要となった背後にある動機や理由
  - **Material for decision**: 決定時に参照した材料
  - **Decision**: 最終的な決定内容と理由
  - **Consequences**: 最終的な結果

# Consequences
- 今後、アーキテクチャやチームの重要なルールに関する意思決定は、このフォーマットに従い `docs/adr/` 配下にマークダウン形式（例: `YYYYMMDD-title.md`）で記録する。
- チーム内での情報の透明性が向上し、過去の意思決定の経緯を誰もが簡単に振り返ることができるようになる。