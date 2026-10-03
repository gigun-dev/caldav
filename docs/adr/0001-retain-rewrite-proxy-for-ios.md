# iOS の正式入口に書き換えプロキシを維持する

Date: 2026-10-02

2026-07 の実測では Workers の入口が MKCALENDAR を通さず、iOS に Extended MKCOL へのフォールバックもなかったため、Cloud Run 書き換えプロキシを恒久構成とする既存判断を移送する。Workers へ直接接続する構成や Workers 前段のフィルタでは、この入口制約を解消できない。

根拠: [認証調査 §4](../modeling/07-authentication.md)、[実機検証](../modeling/06-ios-behavior-verification.md)。2026-07-10 の作業経緯は Git 履歴を参照する。

Rejected: iOS を Workers へ直接接続する構成。
