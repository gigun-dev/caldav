# App Password の既定ハッシュに salt 付き SHA-256 を使う

Date: 2026-10-02

2026-07-15 の利用者裁可済み判断を移送する。サーバー生成の高エントロピー App Password に対しては、Basic の毎リクエストで Argon2id の CPU・レイテンシコストを払わず、salt 付き SHA-256 を既定とし、PHC 文字列で方式を自己記述させる。人間が選ぶ低エントロピーのパスワードを扱う場合の方式とは分ける。

根拠: [認証方式 §5](../modeling/07-authentication.md)。

Rejected: サーバー生成 App Password にも Argon2id を一律適用する。
