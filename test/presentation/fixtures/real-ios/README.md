# iOS探索要求の原本fixture

`principal-propfind.xml`(14プロパティ)と`home-propfind.xml`(38プロパティ)は、
iOS/26.5 (23F77) dataaccessd/1.0 の実機`PROPFIND`要求bodyをJSONから復元したもの。
principalはDepth 0、homeはDepth 1。全namespace宣言・prefix・case・空白を保持している。
ヘッダと要求pathは保存していない。bodyにはプロパティ名だけがあり、ユーザー名・host・
href・UID・イベント/タスクの本文は無いので、body自体への置換は不要だった。

復元元は既存ローカル保存された `[DUMP][req]` ツール出力:
`~/.claude/projects/-Users-gigun-ghq-github-com-gigun-dev-caldav/69499463-0864-4e96-acd6-3d8e8c128748/tool-results/bqh5xp0dw.txt`。
ファイルmtimeは2026-07-13。`b6taf7q5f.txt`(mtime 2026-07-12)にも同じ14/38要求が
remindd/3976の要求として残る。mtimeは保存日時の参考で、要求の正確な発生時刻は記録されていない。
modeling/06の2026-07-10 `[CAP]` 原本そのものではなく、後日の本作で採取した同じ探索要求である。

復元bodyのSHA-256:

- principal: `4e823c623556a58a6c8c6a317d958793aadcc1e15e2297a4fe9f6c93999fa39a`
- home: `34c5eefa58b1e4554dbb7ec7d784bb051e7d55bff1cd471febfedaac4c2c528d`

`ios-discovery-fixtures.test.ts`はprincipal/home/calendar/tasks相当の集合について、
要求全件のURIとlocal名を200/404へ漏れなく分けることを確認する。
実機を現在の実装に接続した受け入れ検証の代わりには扱わない。
