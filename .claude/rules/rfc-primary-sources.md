---
paths:
  - "src/domain/**"
  - "src/application/**"
  - "docs/modeling/**"
  - "docs/rfc/**"
  - "docs/specs/**"
---

# RFC の主張は必ず原文で確認する

**RFC / draft の仕様を根拠に判断・実装するときは、必ず `docs/rfc/`(および `docs/specs/`)の
原文全文スナップショットを読むこと。** 学習済み知識や要約に頼らない。

- 経緯: RFC 7986 で学習済み知識由来の過剰な断定が入り込んだ反省(docs/rfc/README.md)。
  2026-07-11 の J-3 でも原文照合が設計メモの誤りを複数訂正した実績あり。
- スナップショットが無い RFC / draft を参照する必要が出たら、先に原文を取得して
  docs/rfc/ (RFC) / docs/specs/ (draft) に追加してから実装する。
- 照合結果は docs/modeling/05 に記録する。
- SUDO モデリング(docs/modeling/01〜04)が実装の正。図と RFC の乖離に気づいたら
  コードではなく先に図を直す。
