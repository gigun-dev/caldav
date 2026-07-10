# 07 — 認証方式の調査と設計判断(M2 の一次資料)

2026-07-10 調査(Web 一次情報ベース、subagent 5本で独立調査・相互裏取り)。
発端: 「Google アカウントは OAuth で追加できるのに CalDAV の Basic は不安では?」という疑問。
結論を先に書く: **不安の本体は Basic という方式ではなく「マスターパスワードの共有」であり、
解決策は業界デファクトの App Password(M2 の既定計画そのもの)**。

---

## 1. iOS が汎用 CalDAV サーバーに対して使える認証方式

### 事実

- iOS の手動設定 UI(設定 > カレンダー > アカウント追加 > その他 > CalDAV)には
  **ユーザー名/パスワード欄しかなく、OAuth フローを開始する手段が存在しない**。
  対応方式は Basic / Digest のみ(NTLM 非対応)。
  - https://www.webdavsystem.com/server/access/caldav/ipad_iphone_calendar/
  - https://support.apple.com/en-gb/guide/deployment/depd57d3a18/web
- `.mobileconfig` の `com.apple.caldav.account` ペイロードは一次資料
  (Apple Configuration Profile Reference PDF 2019-05-03 版 p.16)では **7キーのみ**:
  `CalDAVAccountDescription` / `CalDAVHostName` / `CalDAVUsername` / `CalDAVPassword` /
  `CalDAVUseSSL` / `CalDAVPort` / `CalDAVPrincipalURL`。**OAuth 関連キーは無い**。
  - https://developer.apple.com/business/documentation/Configuration-Profile-Reference.pdf
  - 注: 検索結果の AI 要約に「CalDAVOAuth キーがある」という主張が出たが、
    一次資料では確認できなかった(2エージェントで独立に検証、どちらも不存在の結論)。
    新しい DDM(Declarative Device Management)の `AccountCalDAV` は未確認
    (ページが JS レンダリング依存で取得不能)。将来 DDM を使うなら再調査。
- **「Sign in with Google」は Google 専用にハードコードされた iOS 統合**であり、
  汎用 CalDAV アカウントには適用されない。Google は 2025-03-14 に CalDAV/IMAP/SMTP の
  パスワード認証を全廃し OAuth のみにしたが、それが成立するのは iOS 側に専用フローが
  あるから。自前サーバーで OAuth サーバーを実装しても iOS 標準クライアントからは使えない。
  - https://support.google.com/a/answer/14114704?hl=en
  - https://developers.google.com/workspace/calendar/caldav/v2/guide

### 判断

**iOS 向けは Basic over HTTPS 一択**(Digest は §3 の理由で不採用)。
OAuth は「できない」が正解であり、劣った選択をしているわけではない。

---

## 2. 業界実例 — Basic + App Password がデファクト

| サービス | CalDAV 認証 | 備考 |
|---|---|---|
| **iCloud** | Basic + App-Specific Password | OAuth 未導入。16文字 `abcd-efgh-ijkl-mnop` 形式、最大25個。メインパスワードは 401 | 
| **Fastmail** | Basic + App Password | 32文字ランダム(0/1/O/I 除く)。メインパスワード使用不可 |
| **Nextcloud** | Basic + App Password | 2FA 有効時は App Password が唯一の手段 |
| **Radicale** | Basic(htpasswd、bcrypt 推奨) | v3.5.0+ はデフォルト全拒否(denyall) |
| **Baïkal** | Basic(Digest は互換問題で実質非推奨) | |
| **Synology** | 素の Basic(App Password 無し) | 2FA 併用不可が未解決課題として残る |
| **Google** | OAuth のみ(2025-03 完遂) | iOS 専用フロー前提。汎用サーバーの参考にならない |

- 出典: https://support.apple.com/en-us/102654 /
  https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords /
  https://help.nextcloud.com/t/caldav-and-oauth2-oidc/214815 /
  https://radicale.org/master.html / https://sabre.io/baikal/troubleshooting/ /
  https://kb.synology.com/en-me/DSM/tutorial/How_to_Sync_Synology_Calendar_with_CalDAV_Clients

**Apple 自身が iCloud で App Password + Basic を使っている**ことが最も強い傍証。
Nextcloud は OAuth 対応済み製品なのに CalDAV では App Password にフォールバックしている
(CalDAV クライアントが OAuth リダイレクトを扱えないため)。

---

## 3. Basic over HTTPS のリスク評価と Digest の不採用理由

### Basic のリスク(HTTPS 前提)

- RFC 4791 §11: 「Basic は TLS なしで MUST NOT」→ TLS 下なら許容。
  RFC 7617 §4 も同旨(TLS なし SHOULD NOT)。
- 残るリスクと緩和:
  1. **ブルートフォース** — Basic は無限に試行できる → **レート制限必須**
     (Nextcloud は 30分/10回失敗で 429 + 最大25秒遅延がデフォルト)。
  2. **マスターパスワード漏洩の波及** — App Password で分離・個別失効。
  3. **2FA バイパス** — CalDAV の Basic は 2FA を素通りする
     (Vikunja の実 CVE: GHSA-47cr-f226-r4pq)。
     App Password を「2FA/ログイン通過後にのみ発行できる」設計にすれば解消。
- App Password をサーバー生成の32文字級ランダム(約190bit)にすれば全探索は非現実的。

### Digest を選ばない理由(2026 年時点)

1. HTTPS 下では Basic に対する追加防御がほぼ無い(Digest が守るのは平文経路の傍受のみ。
   能動的攻撃者は Digest→Basic ダウングレードが可能)。
2. サーバー側に平文 or 弱いハッシュ(MD5系)の保管を強いる — Argon2/bcrypt が使えない。
3. iOS/クライアント実装が不均一で認証ループ等の互換問題が多発
   (sabre/dav、Nextcloud、YetiForce で報告多数)。
4. RFC 7616(SHA-256 Digest)はブラウザですら実装が揃っていない。
- 出典: https://datatracker.ietf.org/doc/html/rfc7616 /
  https://github.com/go-vikunja/vikunja/security/advisories/GHSA-47cr-f226-r4pq /
  https://docs.nextcloud.com/server/stable/admin_manual/configuration_server/bruteforce_configuration.html

---

## 4. プロキシ ↔ Worker 間の内部認証(MKCALENDAR 書き換え経路)

### 現状評価

- 現在の**静的共有シークレットヘッダは Cloudflare 公式の "protect your origin" パターン**
  ("Moderately secure" と明記)。AWS ALB→origin のカスタムヘッダ方式と同系。
  TLS 前提 + workers.dev は IP 非公開、という条件下では現規模で妥当。
  - https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/
- 弱点: リプレイ耐性なし / 漏洩時は全面突破 / ローテーションが手動で両側同時変更が必要
  (2026-07-10 の secret 消失インシデントでローテーション運用の脆さは実体験済み)。

### 代替の比較(workers.dev 制約込み)

| 方式 | リプレイ耐性 | workers.dev | コスト | 評価 |
|---|---|---|---|---|
| 静的シークレット(現状) | なし | ✅ | 最低 | 現規模で妥当 |
| **HMAC-SHA256 + タイムスタンプ** | あり | ✅ | 低(両側±15行) | **格上げ先の本命** |
| Cloudflare Access サービストークン | あり | ✅(2025-10〜) | 中 | 1経路には過剰 |
| GCP OIDC ID トークン + JWKS 検証 | あり | ✅ | 中 | GCP 依存が増え過剰 |
| mTLS(API Shield) | 最高 | ❌ カスタムドメイン必須 | 高 | 現構成では不可 |

- HMAC は Workers の `crypto.subtle` 標準サポートで外部依存ゼロ。公式サンプルあり:
  https://developers.cloudflare.com/workers/examples/signing-requests/
  鍵は現行の PROXY_SHARED_SECRET を流用可能。クロックスキュー許容は 60〜300 秒で十分
  (M2M でドリフト極小)。
- 移行トリガー: **OSS として公開する時 / プロキシ経路が複数になる時 / M2 実装のついで**。

### プロキシ廃止の道は無い(2026-07 時点)

- Cloudflare 公式は「CONNECT 以外の全メソッドを Worker に渡す」と記載するが、
  実測では MKCALENDAR は 501(06 の C1)。workerd のメソッドパーサーが RFC 4791 固有
  メソッドを認識しないためで、修正見込みの issue も無い。
- Snippets(Workers の前段フィルタ)/ Spectrum(L4)も解決にならない。
- → **書き換えプロキシは恒久構成として正しい**(06 B7 ❌ の結論を再確認)。

---

## 5. 設計判断(結論)

1. **M2(iOS 向け)**: Basic over HTTPS + **App Password** を正式採用。
   - サーバー生成 32 文字級ランダム(`crypto.getRandomValues`)。ユーザーに選ばせない。
   - D1 には **salt 付き強ハッシュ(Argon2id 推奨、無ければ bcrypt)のみ**保存。
     ※ Workers は WebCrypto に Argon2 が無いため wasm ポートの検討が必要。
   - 発行は認証済み Web UI から。**一度だけ表示**、以降は失効・一覧のみ。
   - **レート制限**を認証エンドポイントに必須で入れる(Workers 内カウンター or
     Cloudflare Rate Limiting)。
   - .mobileconfig 配布(ワンタイム URL + HTTPS)は計画どおり。
2. **プロキシ内部認証**: 当面は静的共有シークレット継続。
   M2 実装時か OSS 公開時に **HMAC-SHA256 + タイムスタンプ署名**へ格上げ(低コスト)。
3. **OAuth**: iOS 向けには実装しない(iOS 側に受け口が無い)。
   **M6 の agentic 入口(REST / MCP / Web フロント)で Bearer トークン(RFC 6750)として
   導入**するのが適所。iCloud と同じ役割分担(人間の CalDAV は App Password、
   プログラマブル API は トークン)。
   CalDAV 向け OAuth スコープの IETF draft(draft-ietf-mailmaint-oauth-public)は
   進行中だが実装は希少 — M6 時点で再調査。
