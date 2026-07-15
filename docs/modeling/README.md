# SUDO モデリング成果物

松岡幸一郎氏の DDD における SUDO モデリング(システム関連図 → ユースケース図 →
ドメインモデル図 → オブジェクト図)の成果物。**実装はこれらの図を正とする。**
実装中に図と RFC の乖離に気づいたら、コードより先に図を直すこと。

| 図 | ファイル | 答える問い |
|----|---------|-----------|
| S: システム関連図 | [01-system-context.md](01-system-context.md) | 誰が・何と・どう繋がるか |
| U: ユースケース図 | [02-usecases.md](02-usecases.md) | 何を達成するか(+実装順の根拠) |
| D: ドメインモデル図 | [03-domain-model.md](03-domain-model.md) | 概念・不変条件・集約境界(+ユビキタス言語) |
| O: オブジェクト図 | [04-object-diagrams.md](04-object-diagrams.md) | モデルが実データを表現できるか |
| RFC 原文照合の記録 | [05-rfc-verification.md](05-rfc-verification.md) | 図の主張は原文で裏取りされているか(+図に書ききれない細則集) |
| iOS 実機挙動の検証 | [06-ios-behavior-verification.md](06-ios-behavior-verification.md) | 最も気難しいクライアント(iOS)で実際にどう動くか |
| 認証方式の調査 | [07-authentication.md](07-authentication.md) | iOS/CalDAV で使える認証は何か・App Password 採用の根拠(M2 一次資料) |
| 意味計算の調査 | [08-recurrence-engine-survey.md](08-recurrence-engine-survey.md) | RRULE 展開・TZ・free-busy をどう実装するか(方向性 G 一次資料) |
| 標準戦略の調査 | [09-standards-strategy.md](09-standards-strategy.md) | どの RFC に従い・切り・先行投資するか(方向性 J 一次資料 + G の優先度補正) |
| メール統合の調査 | [10-email-integration.md](10-email-integration.md) | iMIP 送受信・予定抽出をどう実現するか(方向性 K 一次資料) |
| agentic 露出面の調査 | [11-agentic-surfaces.md](11-agentic-surfaces.md) | MCP Apps / WebMCP をどう位置づけるか + 着手順の DDD 戦略設計(方向性 E 一次資料) |
| VEVENT の agentic 入口 | [12-vevent-agentic.md](12-vevent-agentic.md) | E-3(VEVENT ツール + アジェンダカード)の設計の正・Event DTO / VALARM / 移動時間 |
| マルチユーザー + アイデンティティ | [13-multiuser-identity.md](13-multiuser-identity.md) | 方向性 A の設計の正・2階建て認証 / 自前 SIWA ファースト / A-1 スキーマ / 権限表 / R-7 |

一次資料の RFC: 5545(iCalendar)/ 7986(拡張プロパティ)/ 4918(WebDAV)/
4791(CalDAV)/ 6578(sync-collection)/ 6764(探索)/ 5397(current-user-principal)/
6638・5546・6047(スケジューリング系・将来)。
