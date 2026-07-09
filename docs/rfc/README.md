# RFC 原文アーカイブ

> 2026-07-09 導入。このプロジェクトの一次資料である RFC の全文を rfc-editor.org から
> 取得してここに置く。**モデリング・実装・レビューで RFC の主張を確認するときは、
> 学習済み知識や要約ではなく必ずこのディレクトリの原文を読むこと**(人間も AI も)。
>
> 動機: RFC 7986 について「iOS 対応に不要」という過剰な断定が docs に入り込み、
> レビューで訂正された(05-rfc-verification.md の 2026-07-09 訂正)。学習知識ベースの
> 照合は取りこぼしがあるため、原文をリポジトリに常備してオフラインで即照合できるようにする。
> ネットワーク fetch も不要になり、subagent への「原文照合せよ」という指示が確実に実行できる。

| ファイル | タイトル | 本プロジェクトでの位置づけ |
|---------|---------|--------------------------|
| rfc5545.txt | iCalendar | ドメイン層の本体(実装済み: 構造層・値型・意味論レンズ) |
| rfc7986.txt | iCalendar Property Extensions | NAME/COLOR/IMAGE/CONFERENCE 等。生値保持で往復済み、アクセサは必要時に追加 |
| rfc4918.txt | WebDAV | PROPFIND / PROPPATCH / MKCOL / 207 Multi-Status(実装フェーズ2) |
| rfc4791.txt | CalDAV | MKCALENDAR / REPORT / PUT preconditions(実装フェーズ3) |
| rfc6578.txt | Collection Synchronization | sync-collection REPORT / sync-token(実装フェーズ4) |
| rfc6764.txt | Locating CalDAV Services | .well-known/caldav 探索 |
| rfc5397.txt | WebDAV Current Principal | current-user-principal |
| rfc7232.txt | HTTP/1.1 Conditional Requests | ETag / If-Match / If-None-Match |
| rfc5546.txt | iTIP | スケジューリング(将来フェーズ・輪郭のみ) |
| rfc6638.txt | CalDAV Scheduling | スケジューリング(将来フェーズ・輪郭のみ) |
| rfc3744.txt | WebDAV ACL | Principal / current-user-privilege-set の定義元(RFC 4791 も参照) |
| rfc5689.txt | Extended MKCOL | MKCALENDAR 代替の拡張 MKCOL(02-usecases 参照) |
| rfc6868.txt | Parameter Value Encoding | パラメータ値の ^ エスケープ。**現行シリアライザの「DQUOTE 表現不可エラー」に直接関係**(下記注意) |
| rfc7617.txt | Basic HTTP Authentication | iOS の確定要件である Basic 認証(認証実装フェーズ) |
| rfc9110.txt | HTTP Semantics | HTTP 現行仕様。**RFC 7232 は 9110 に obsolete された**(7232 は 4791 §5.3.4 が引く歴史的文脈用に残す) |
| rfc9074.txt | VALARM Extensions | ACKNOWLEDGED / PROXIMITY(位置アラーム)/ VALARM 内 UID。**iOS リマインダーが ACKNOWLEDGED を送ってくる**(fixtures の ios-event.ics 参照)ため候補から昇格(2026-07-09) |

<!-- 2026-07-09 追加5本(codex 指摘)+ 9074(iOS リマインダー直結のため昇格)。
     さらに将来の追加候補として RFC 6047(iMIP — メール輸送までやるとき)/
     RFC 7529(RSCALE 非グレゴリオ暦 RRULE — 現行パーサーは未知 rule-part として拒否する。
     iOS が旧暦繰り返しで RSCALE を送るかは docs/modeling/06 A8 で検証)/
     RFC 7809(Time Zones by Reference)/ RFC 3986(URI)を認識している。
     必要になったフェーズで取得する。 -->

> **RFC 6868 の注意(2026-07-09)**: serializer.ts は「DQUOTE を含むパラメータ値は RFC 5545 の
> 文法上表現不可」として SerializeError にしているが、RFC 6868 は `^'`(DQUOTE)/ `^n`(改行)/
> `^^`(キャレット)のエンコードを定義しており、これを実装すれば表現可能になる。
> Apple クライアントも ^ エンコードを送ってくることがある(生値保持なので往復は壊れないが、
> パラメータ値の解釈時にデコードが必要)。パーサ/シリアライザへの対応可否は実装フェーズで判断し、
> 結果を 05 に記録すること。

## 使い方の約束

- 照合の記録は docs/modeling/05-rfc-verification.md に残す(このディレクトリは原文のみ、
  解釈は書き込まない)。
- 原文は plain text(IETF の正本形式)。セクション参照は `grep -n "^3.8.2.3" rfc5545.txt`
  のように節番号で引ける。ページヘッダ/フッタ(改ページ)が本文に挟まる点に注意。
- 更新(errata 反映等)はしない — 取得日時点のスナップショットとして扱い、
  errata が問題になったら個別に調べて 05 に記録する。
