# Harness から todo / ADR への移行

2026-10-02。利用者の依頼で todo / ADR へ移行し、ND の現行運用を廃止する。
[配布元の移行手順](../../claude-code/docs/harness/migration.md)に沿って、このリポジトリだけを変更した。

## 運用と保存範囲

- `todo.txt` を現行タスク、`done.txt` を検証済み完了記録とする。取り込み日を作成日とし、done は空で開始する。
- `docs/adr/` に既存判断4件を移送する。ADR の日付は移送日で、元の判断日と根拠は本文に残す。
- ND の頭・4カタログ・log は本文を削らず凍結する。旧完了項目を再検証済みとして done に取り込まない。
- CLAUDE / Codex の SessionStart 設定・スクリプト・symlink を撤去する。
- 指示・project skills・Codex README の ND/log 更新指示を置き換える。RFC/modeling の規律は維持する。
- pre-push は Harness の文書検査ではなく `make check` を実行するため維持する。Makefile/CI に旧 ND 検査は無かった。
- hub と swift-mcp-app の作業は各リポジトリの所有であり、こちらの todo には登録しない。
- 現行タスクに付けた依存は、既存の着手順・明示された前提・同じ作業内の段階を移したもの。
  実装タスクを進める承認や、本番変更・実機検証の実施を意味しない。

## 未完了項目の対応

旧計画に安定 ID がない項目は節名・記述で対応させる。詳細な保証条件・リスクは `see:` 先に保存し、
着手時に現行コード・本番状態を確認する。カードの「他に○件」は頭の本番受け入れと重なるため、
再実装タスクにせずカード非回帰確認に含める。

| 旧項目 | todo ID | 詳細・根拠 |
| --- | --- | --- |
| 是正(a) | 0001 | `docs/next-directions-caldav-ios.md` |
| 是正(b) | 0002 | `docs/next-directions-caldav-ios.md` |
| 是正(d) | 0003 | `docs/next-directions-caldav-ios.md` |
| 是正(e) | 0004 | `docs/next-directions-caldav-ios.md` |
| 未着手課題1〜8 | 0005 | `docs/next-directions-caldav-ios.md` |
| 未着手課題1 | 0006 | `docs/next-directions-caldav-ios.md` |
| 未着手課題2 | 0007 | `docs/next-directions-caldav-ios.md` |
| 未着手課題3 | 0008 | `docs/next-directions-caldav-ios.md` |
| 未着手課題4 | 0009 | `docs/next-directions-caldav-ios.md` |
| 未着手課題5 | 0010 | `docs/next-directions-caldav-ios.md` |
| 未着手課題6 | 0011 | `docs/next-directions-caldav-ios.md` |
| 未着手課題7 | 0012 | `docs/next-directions-caldav-ios.md` |
| 未着手課題8 | 0013 | `docs/next-directions-caldav-ios.md` |
| 実機バグ① | 0014 | `docs/next-directions-agentic-ui.md` |
| 実機バグ② | 0015 | `docs/next-directions-agentic-ui.md` |
| iOS カード操作 / UI v3 | 0016 | `docs/next-directions-caldav-ios.md` |
| agenda fullscreen | 0017 | `docs/next-directions-caldav-ios.md` |
| geo 無し LOCATION | 0018 | `docs/next-directions-caldav-ios.md` |
| search-location E2E | 0019 | `docs/next-directions-caldav-ios.md` |
| 移動時間・通知 | 0020 | `docs/next-directions-caldav-ios.md` |
| J-4 | 0021 | `docs/next-directions-caldav-ios.md` |
| R2 iOS | 0022 | `docs/next-directions-caldav-ios.md` |
| swipe 削除 | 0023 | `docs/next-directions-caldav-ios.md` |
| IAD 再計測 | 0024 | `docs/next-directions-operations.md` |
| MCP 2026-07-28 | 0025 | `docs/next-directions-operations.md` |
| A 未確定点 | 0026 | `docs/next-directions-roadmap.md` |
| A-1 | 0027 | `docs/next-directions-roadmap.md` |
| A-2 | 0028 | `docs/adr/0002-hash-generated-app-passwords-with-sha256.md` |
| A-3 | 0029 | `docs/adr/0002-hash-generated-app-passwords-with-sha256.md` |
| A-4 | 0030 | `docs/modeling/07-authentication.md` |
| make dev | 0031 | `docs/next-directions-roadmap.md` |
| list-todos due | 0032 | `docs/next-directions-agentic-ui.md` |
| 表示順序 G-1 | 0033 | `docs/next-directions-agentic-ui.md` |
| 表示順序 G-2〜G-5 | 0034 | `docs/next-directions-agentic-ui.md` |
| R3 | 0035 | `docs/adr/0003-delegate-confirmation-to-hosts.md` |
| 配色 A-4 | 0036 | `docs/card-color-audit-2026-08-02.md` |
| sync hydrate N+1 | 0037 | `docs/next-directions-operations.md` |
| OTel | 0038 | `docs/next-directions-roadmap.md` |
| 本番データ掃除 | 0039 | `docs/next-directions-roadmap.md` |
| #30 残 | 0040 | `docs/next-directions-roadmap.md` |
| OAuth 確認2点 | 0041 | `docs/next-directions-operations.md` |
| K-1 | 0042 | `docs/next-directions-roadmap.md` |
| K-2 | 0043 | `docs/next-directions-roadmap.md` |
| K-3 | 0044 | `docs/next-directions-roadmap.md` |
| K-4 | 0045 | `docs/next-directions-roadmap.md` |
| B | 0046 | `docs/next-directions-roadmap.md` |
| D | 0047 | `docs/next-directions-roadmap.md` |
| H | 0048 | `docs/next-directions-roadmap.md` |
| I | 0049 | `docs/next-directions-roadmap.md` |
| 小 nit placeholder | 0050 | `docs/next-directions-roadmap.md` |
| G-4 UI | 0051 | `docs/next-directions-agentic-ui.md` |
| E 起票のみ | 0052 | `docs/next-directions-agentic-ui.md` |
| A-1 承認後実装 | 0053 | `docs/next-directions-roadmap.md` |

## 保留・構想・別リポの扱い

- D4 保持期限は ADR 0004 の再訪条件待ち。自動削除を未完了タスクとして復活させない。
- 確認カード S2/S3 と R-8 の非原子2PUT是正は不採用。ADR 0003 と旧ロードマップの裁定を保持する。
- becoming replay nonce、sessionStorage 選好、V6 Phase 2、VALARM 管理、反復 due→DATE の明示エラー、
  delete committing 演出、WebUI、WebMCP、ゾーン変更エッジ、全日→時刻付きの VALARM は旧計画の実害・要望待ち。
- agenda の「あと M 日」、user ごとの週開始曜日、K-5 Siri、Thunderbird 等は任意・将来構想として旧カタログに保存。
- swift-mcp-app の R4・#34・#41・HOLB と hub H0/R0 は移管済み。現況確認はそれぞれのリポジトリで行う。
- 長期 A〜K の構想は具体的な次の設計・判断タスクとして取り込み、実装一式を一行で完了扱いにしない。

## 検証

- `todo check`: 53行 PASS。`adr check`: 4件 PASS。`ready` に ADR 索引と依存解消済みタスクが出る。
- 対応表の53 ID、全 `see:`、ADR の参照先、空の done、AGENTS symlink を確認。
- 旧 ND/log は凍結注記を除き HEAD の本文と一致。SessionStart の両ホスト設定・スクリプト撤去を確認。
- `git diff --check`: PASS。lockfile・生成型・pre-push 本文の変更なし。
- `make check`: 境界・型・Bun 1111件・Worker 42件 PASS（終了コード0）。初回はローカル依存不足で停止し、
  `bun install --frozen-lockfile` で固定依存を復元してから再実行した。
- `doctor check`: pre-push 未登録の警告だけ残る。実際の `core.hooksPath` はリポジトリの `.githooks` の絶対パスで、
  `git rev-parse --git-path hooks/pre-push` が既存実行ファイルを指すことを確認した。
  doctor はディレクトリ文字列を相対パスと直接比較するため誤検知する。Git 設定は変更していない。
- 新規 Claude/Codex 会話でのスキル自動選択・旧フック出力消失は未実測。設定と参照の静的確認まで。
- この移行により将来の運用指示を切り替えた。本番の残検証、実機検証、SDK 互換性を新たに完了とはしていない。

グローバル設定・他リポジトリ・本番は変更していない。コミット・push はしていない。
