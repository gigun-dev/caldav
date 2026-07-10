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

一次資料の RFC: 5545(iCalendar)/ 7986(拡張プロパティ)/ 4918(WebDAV)/
4791(CalDAV)/ 6578(sync-collection)/ 6764(探索)/ 5397(current-user-principal)/
6638・5546・6047(スケジューリング系・将来)。
