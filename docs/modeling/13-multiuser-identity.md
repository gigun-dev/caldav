# 13. A(M2 マルチユーザー)— アイデンティティ層 + A-1 スキーマ設計

> 位置づけ: 方向性 A(マルチユーザー化)の**設計の正**。実装が図と乖離したら先にこちらを
> 直す(CLAUDE.md)。2026-07-15 に Fable architect 2本の調査(A-1 スキーマ / アイデンティティ
> 戦略)+ ユーザー裁可(ハッシュ方式・進め方)を統合。R-7(CAS)は本設計と同時に着手し
> **実装済み**(`4c12374`)。本ファイルは A-1(スキーマ + アイデンティティ骨格)と、その先の
> A-2〜A-4 の輪郭を定める。認証方式の一次調査は docs/modeling/07 が土台。

## §0 このドキュメントが生まれた経緯(Why)

A-1 の初期設計(principal 複数化 + app_passwords テーブル)を詰めていたとき、ユーザーから
本質的な指摘が入った:

> 「マルチユーザーにするなら、そもそも**誰がどこでアカウント登録**して principal を作るのか?
> じゃないと**誰に App Password を発行**するか決まらない。Firebase? better-auth?
> Sign in with Apple? MCP で使うにせよアカウント登録は Web かアプリのどこかでするはず。」

これは正しく、初期 A-1 設計は「**下の階**(CalDAV デバイス資格情報 = App Password)」だけで、
「**上の階**(アイデンティティ / サインアップの入口)」が空白だった。本ドキュメントはその上の階を
定義し、下の階(A-1 スキーマ)と接続する。

## §1 認証は必ず2階建て(CalDAV の宿命)

**iOS の CalDAV クライアント(設定アプリのアカウント)は Basic しか喋れない。**
Sign in with Apple / Firebase / OAuth のどれを上の階に選んでも、iOS に予定を配信する以上、
最終的に必ず Basic 用の資格情報 = **App Password** が要る(iCloud の app-specific password と
同じ宿命)。つまり上の階は App Password の "置き換え" ではなく "上に乗る" 関係。

```
[上の階] IdentityPort(アカウント = 誰か。低頻度・サインアップ/ログイン時のみ)
   │  ログイン成立 → user_id 確定
   ▼
[下の階] 資格情報(何で入るか。毎リクエストのホットパス)
   - App Password(CalDAV Basic)         ← A-1・下記 §4
   - OAuth grant(workers-oauth-provider) ← 既存・R-6
   - SIWA identity token(iOS ネイティブ) → 検証して user_id へ解決
```

- **上の階 = `IdentityPort`(新設)**: アカウントのライフサイクル(サインアップ/ログイン/連携)。
- **下の階 = `AuthenticationPort`(既存)**: 資格情報 → `PrincipalRef`。毎リクエストのホットパス。
- **2ポートを分ける理由(Why not 単一ポート)**: 混ぜると Basic 検証のホットパスに IdP 依存
  (JWKS fetch 等)が漏れる。頻度も関心事も違う(§4 の App Password 検証は毎リクエスト、
  IdentityPort はサインアップ時のみ)。

## §2 アイデンティティ層戦略: 自前・SIWA ファースト(better-auth 不採用)

**採用: 自前アイデンティティを D1 で持つ。第一歩は「SIWA ファースト最小自前実装」。
better-auth は採用せず、seam 裏の将来オプションに留める。**(ユーザー裁可: 2026-07-15)

### 一次資料で確認した事実(§9 に出典)

- **Apple App Review Guideline 4.8**: SIWA が必須になるのは「サードパーティ/ソーシャル
  ログインでプライマリアカウントを作る場合」のみ。**自社アカウントシステムのみなら不要**。
  ただし Google ログイン等を足した瞬間に同等オプション(実質 SIWA)が義務化。
- **SIWA バックエンド検証**: `https://appleid.apple.com/auth/keys` の JWKS で JWT 署名検証 +
  `iss` / `aud`(= Bundle ID)/ `exp` / `nonce` を検証するだけ。**Apple SDK 不要・任意の自前
  バックエンドで可**。Workers の `crypto.subtle`(or jose)で完結、~50 行。`sub` が安定 ID。
  **email クレームは初回認可時のみ**返る(以降省略)→ 初回に必ず保存する規律が要る。
- **better-auth**: Workers + D1 で動く(Hono 公式例あり)が、D1 直はコミュニティ製アダプタ
  依存。user/session/account/verification の4テーブルを要求。

### Why not better-auth

今必要な機能は「SIWA idToken 検証 + user get-or-create +(SaaS 期に)メール認証」だけ。
そのために **4テーブル + セッション管理 + コミュニティ製 CF アダプタ**を背負うのは過剰。
致命的なのは、**better-auth のテーブルが users スキーマの "正" になると A-1 が外部ライブラリの
都合に不可逆に縛られる**こと。逆に自前 users を "正" にしておけば、Web UI が本格化した将来に
better-auth を「セッション/フォーム担当のアダプタ」として users にマッピングして載せる道は
残る(**判断が可逆**)。よって却下ではなく「seam 裏の将来オプション」に格納する。

### Why not 外部マネージド IdP(Firebase / Clerk / WorkOS)

self-host キットビジョン(CLAUDE.md)と正面衝突する(seam 裏に隠しても「既定で外部必須」は
キットとして失格)。Firebase Admin SDK は Node 前提で Workers に不適(REST 検証は可だが歪む)。
分析バンドルが唯一の加点だが §6 で否定される。

### Why not workers-oauth-provider の流用

これは「当サーバーが MCP クライアントに対する**認可サーバー**」であって、エンドユーザーの
**アカウント DB ではない**。役割違いで却下(ただし廃止でもない)。正しい役割分担は
「`/authorize` の同意画面の中で、"誰であるか" の確認を IdentityPort に委譲する」。

## §3 3入口の収束アーキテクチャ

単一の正 = `users`(1行 = 1人)。principal は users の下に置く(`principals.owner_user_id →
users.id`)。既存 A-1 と矛盾せず「principals の上に users を1枚足す」だけ。

1. **iOS ネイティブ(swift-mcp-app / companion)**: ASAuthorizationController → identity token を
   `POST /identity/apple` へ → JWKS 検証 → `apple_sub` で get-or-create → 以降は既存の
   **MCP OAuth 2.1 フロー**(swift-sdk)に乗る。
2. **MCP OAuth(claude.ai / アプリ)**: `/authorize` 同意画面の「固定パスワード入力」を
   **IdentityPort ログイン**(SIWA ボタン。SaaS 期にメール magic link 追加)に置換。grant の
   props に `userId` を焼き込み、OAuthPropsAuth が `PrincipalRef` 解決時に user→principal を引く
   (R-6 の scopes の運び方は不変。props に userId が加わるのみ)。
3. **CalDAV Basic**: ログイン済み Web(または MCP ツール/カード)から App Password 発行 →
   `app_passwords.user_id` に紐付け。**発行の前提条件 = 「上の階の認証済み」**(07 §3 の
   2FA バイパス対策と同じ論理 — 未認証に App Password を配ってはならない)。

## §4 D1 スキーマ(migration・追加のみ)

> **前方互換規律必須**(migrations/README.md)。ADD COLUMN は NULL 許可、新テーブルのみ、
> 既存テーブルの破壊なし。migrate 先行・deploy 後追いのどちらでも旧コードは壊れない。

### users(上の階・新規)

```sql
users (
  id TEXT PRIMARY KEY,           -- ULID
  email TEXT UNIQUE NULL,        -- SIWA 初回クレーム or メール認証で埋まる。NULL 許容
                                 -- (SIWA private relay の私書箱アドレスもここ)
  email_verified INTEGER NOT NULL DEFAULT 0,
  apple_sub TEXT UNIQUE NULL,    -- SIWA の安定 ID。provider が増えたら user_identities 子テーブルへ
                                 -- 昇格(行コピーだけで可逆)。今は列で持つ(過剰正規化を避ける)
  display_name TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

- **`auth_method` 列は作らない**: 1ユーザーが複数手段を持つのが常態。手段は apple_sub /
  (将来)credential 行の存在で表現する。provider 2個目が現実になった時点で
  `user_identities(user_id, provider, subject)` に正規化 — 今テーブルを増やすのは過剰設計。

### principals の複数化(既存テーブルに追加)

現行 `principals(principal_path PK, calendar_home_set)` は**既に複数行を許す構造**で、
collections/objects/sync_changes の owner FK も配線済み(0001 の設計意図どおり)。必要なのは:

```sql
ALTER TABLE principals ADD COLUMN owner_user_id TEXT;  -- → users.id。NULL 許可で前方互換
ALTER TABLE principals ADD COLUMN created_at INTEGER;
-- login_name は「上の階」ができたので principals に持たせない(旧 A-1 設計から変更)。
-- ログインは users(email / apple_sub)経由。principal_path は URL の関心事に純化。
-- バックフィル: 既存の単一ユーザー行に seed の users.id を紐付ける(単一ユーザー時代は users 1行)。
```

> **旧 A-1 設計(architect 第1稿)からの変更**: 旧稿は `principals.login_name` を認証の入口に
> していたが、上の階(users)を建てたので login 名は users 側(email / apple_sub)が持つ。
> principals は URL 上のアイデンティティ(principal_path)に専念する。

### app_passwords(下の階・A-3 の発行 UI を見越す)

```sql
app_passwords (
  id TEXT PRIMARY KEY,                -- UUID。失効・一覧の操作単位(A-3 の UI が使う)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- ★上の階へ紐付け
  label TEXT NOT NULL,                -- "iPhone 15" 等。一覧表示用
  secret_hash TEXT NOT NULL,          -- PHC 文字列($<scheme>$<params>$<salt>$<hash>)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,               -- 失効判断の材料(書き込みは間引く。毎リクエスト UPDATE しない)
  revoked_at INTEGER                  -- NULL = 有効。物理 DELETE でなく失効時刻を残す(監査)
)
```

**ハッシュ方式 = salt 付き SHA-256(PHC 形式1カラム)**。ユーザー裁可済み(2026-07-15・
modeling/07 §5)。**Why not Argon2id/bcrypt**: App Password はサーバー生成の 32 文字級
(約190bit)高エントロピー秘密で、KDF(ストレッチング)が守る脅威=「低エントロピー人間
パスワードの全探索・辞書攻撃」がそもそも存在しない。一方 Basic は**毎リクエスト**資格情報が
来る(iOS は数分おきに複数リクエスト)ため、Argon2id(wasm・数十ms + 初期化)を毎回払うのは
CPU 課金・レイテンシ両面で重い。WebCrypto の SHA-256 なら <1ms。**PHC 形式1カラム**なので
将来 Web UI のマスターパスワード(低エントロピー・人間選択)を扱う場合は `$argon2id$…` 行を
**混在**でき、方式変更は行単位で可逆。

### auth_throttle(レート制限)

```sql
auth_throttle (
  subject TEXT PRIMARY KEY,            -- login 識別子(存在しないユーザーも数える=ユーザー列挙対策)
  window_started_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0
)
```

固定ウィンドウの失敗カウンタ。**失敗時のみ書く**(成功パスに D1 書き込みを足さない)。閾値は
Nextcloud 準拠(07 §3: 30分/10回 → 429)を初期値に。**IP をキーにしない**(Cloudflare 経由で
IP 信頼性が構成依存 + キー爆発)。Cloudflare Rate Limiting への置き換えは可逆なのでまず D1 で最小に。

### collection_grants(D の権限表・A-1 に織り込み)

```sql
-- 「owner は暗黙の全権」= owner 自身の行は持たない。行が表すのは「他 principal への付与」のみ。
collection_grants (
  collection_owner TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  grantee TEXT NOT NULL REFERENCES principals(principal_path) ON DELETE CASCADE,
  access TEXT NOT NULL CHECK (access IN ('read', 'read-write')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (collection_owner, collection_id, grantee),
  FOREIGN KEY (collection_owner, collection_id)
    REFERENCES calendar_collections(owner, id) ON DELETE CASCADE
)
```

- **根拠(RFC 3744 §5.4 原文確認済)**: current-user-privilege-set は「サーバーが計算した
  非抽象 privilege の正確な集合」。**DB に privilege を個別に持つ義務はなく、access レベル →
  privilege 集合の写像はサーバーの裁量**。現在 `xml.ts:107,131` にハードコードされている
  read/write/bind/unbind の集合は「owner の全権」写像としてそのまま生きる。
- **A-1 での実データ化の範囲**: application に `ResolvePrivileges`(owner なら全権、grants に
  行があればそのレベル、無ければ無権)を置き、`xml.ts` のハードコードをこの結果からの写像に
  差し替える。**現時点で grants は空**なので観測挙動は不変(= 安全なリファクタ)。
- **Why not owner 全権行のバックフィル / フル DAV:acl スキーマ**: 前者は「コレクション作成の
  たびに grants 行も書く」不変条件が全経路に波及する。後者(ace の grant/deny/inherited/
  protected モデル化)は D 着手時に RFC 3744 精読後。deny 語彙を今入れると評価順序まで背負う。

## §5 seam(ポート)設計

```
application/ports/identity.ts(新設・輪郭)
  IdentityPort {
    verifyExternalIdentity(input: { provider: "apple"; idToken: string; nonce?: string })
      → { ok: true; identity: { provider, subject, email? } } | { ok: false; reason }
    getOrCreateUser(identity) → { userId }   // email クレーム初回のみ問題への対処: 初回で必ず永続化
  }
```

- 実装は `infrastructure/identity/apple-siwa.ts`(JWKS fetch + crypto.subtle)+
  `d1-user-repository`。**domain には users を持ち込まない**(アイデンティティは CalDAV
  ドメインの外・アプリケーション層の関心事)。
- self-host キットは「IdentityPort のリファレンス実装 = SIWA +(将来)メール」を同梱し、
  Firebase 等を使いたい人はアダプタ差し替え。

## §6 分析軸(AnalyticsPort で分離・Firebase の加点は消える)

親仮説「Firebase を選ぶ理由が分析バンドルだけなら分離設計で代替できる」は一次情報で**肯定**:

- Firebase Analytics(GA4)はクライアント SDK のイベント計測が本体で、Auth とは製品として別
  レイヤー(同じコンソールという利便であって技術的結合ではない)。
- 当プロダクトの主戦場はサーバーサイド計測(CalDAV/MCP 利用)。既存の `{mcpTool, ms, colo}`
  ログに `userId` を足せば機能利用分析になる。**Workers Analytics Engine は保持3ヶ月**なので
  「運用テレメトリ = WAE / 長期プロダクト分析 = 日次集約を D1(or 将来 PostHog)へ」の2段構え。
- **AnalyticsPort を IdentityPort とは独立に置く**(`track(event, { userId, props })` 程度)。
  リファレンス = WAE アダプタ、self-host 代替 = PostHog(self-host 実在・MIT・~30万イベント/月)。
  SaaS の課金分析は Stripe 側で別途。
- 結論: **分析はアイデンティティ選定の決定要因にならない**。

## §7 R-7(楽観ロックの CAS 化)= 実装済み ✅

A-1 と同時着手・**実装済み**(`4c12374`)。詳細は当該コミットと `src/infrastructure/d1/
repositories.ts`。要点: UoW の batch を3文構成(①CAS UPDATE WHERE sync_counter=baseline →
②sync_changes INSERT → ③自己参照ガード付き object write)にし、①の meta.changes===0 or ②の
PK 制約違反を `ConcurrencyConflictError` → 412 に。`CalendarCollection.baselineSyncCounter` で
hydrate 時の値を保持。R-8 名残(snapshot UID の deterministic 化)も同梱。

> **2026-07-16 訂正(実機フィードバックで CAS 粒度の問題が発覚・modeling/12 §7.4)**:
> コレクション `sync_counter` の baseline 比較 CAS は**別リソースへの並行書き込みまで 412 に
> する過剰ガード**だった(iOS の PUT・LLM の update-event・カードの保存が重なると、対象が別
> リソースでも「変更を保存できません」トースト)。→ **書き込みの前提条件をリソース単位 ETag
> (If-Match 相当)に一本化し、コレクション CAS は廃止**。採番は `sync_counter = sync_counter + 1`
> のアトミックインクリメント。RFC 6578 が要求するトークン単調性は counter の単調増加で保たれ、
> CAS 比較粒度とは独立(コレクション CAS は 6578 由来でなく実装都合だった)。同一リソース競合
> 時は update-event UC 内で1回だけ自動 re-read→re-patch、2回目失敗は isError(R-7「素の 412」を
> 最後の砦に残す)。R-8 の snapshot UID deterministic 化は維持。実装は S-B スライス。

## §8 段階論(最小の第一歩)

- **今(A-1・docs 化のみ完了。実装は未着手)**: 本ドキュメント確定。
- **次の実装スライス(承認後)**: users テーブル + FK 向け先(principals/app_passwords → users)+
  `IdentityPort` 型定義を migration + ports に入れる(単一ユーザー時代は users seed 1行)。
  **実装はここまで**(過剰実装を避ける)。
- **companion / swift-mcp-app MVP 時**: SIWA 検証アダプタ + `/identity/apple` + `/authorize`
  同意画面の SIWA 化。Apple Developer Program($99/年)+ App ID 設定が前提。
- **SaaS 化時**: メール magic link(Cloudflare Email Service)、Web の App Password 発行 UI(A-3)、
  AnalyticsPort の userId 付与、A-2(認証ミドルウェア差し替え)、A-4(プロキシ内部認証 HMAC)。
- **要望が出たら**: better-auth or 外部 IdP アダプタ(seam の裏)。

## §9 未確定の製品判断(実装フェーズで決める)

1. **SIWA の email private relay を許すか**: 許すとメール連絡(iMIP・方向性 K)の到達性が relay
   依存になる。Apple 標準 UX なので許す方向を推奨するが製品判断。
2. **claude.ai コネクタ既存ユーザー(現・固定パスワード grant)の移行**: grandfather(props に
   userId なし → 既定 user へフォールバック)期間をどれだけ置くか。R-6 の grandfather と同型。
3. **授業フェーズで SIWA を待たずメール magic link を先にやるか**: Apple Developer Program と
   App ID 設定が SIWA の前提。companion アプリを出すなら結局必要なので SIWA 先行を推奨だが、
   時期はアプリ計画次第。
   > **2026-07-15 ユーザー情報:** Swift アプリはバイト先の Apple Developer アカウントが使えるため
   > **$99/年の課金は不要**。App Store 配信は相談が要るが、それ以外(App ID / Sign in with Apple
   > capability の設定・実機/シミュレータでの開発検証)は配信不要で行える。→ **SIWA の前提は
   > 開発段階で既に満たせる**ので、SIWA 先行の制約は課金でなく「バイト先アカウントで App ID を
   > 設定する段取り」だけ。App Store 配信を要する段階(SaaS 一般公開)で改めて相談。
4. **分析の長期保管先**(D1 日次集約 vs PostHog Cloud)は SaaS 化時に再判断で十分。

## §10 参照した一次資料

- **RFC 3744 §5.4**(current-user-privilege-set = サーバー計算・非抽象 privilege の集合)—
  `docs/rfc/rfc3744.txt`
- **RFC 7232 / 9110**(412 と条件付きリクエストの語彙)— R-7 の 412 マッピング根拠
- Apple App Review Guidelines **4.8**(SIWA 必須条件と自前アカウント例外)
- Apple "Verifying a user"(signinwithapple・JWKS 検証手順・email クレーム初回のみ)
- better-auth 公式 docs(authentication/apple・concepts/database)/ Hono 公式 better-auth on
  Cloudflare 例 / better-auth-cloudflare(コミュニティアダプタ)
- Cloudflare **Workers Analytics Engine** limits(保持3ヶ月・20 blobs 等)
- **PostHog self-host**(MIT・Docker Compose・~30万イベント/月推奨)
- docs/modeling/07(認証方式の確定調査)/ migrations/0001_init.sql + README(前方互換規律)/
  src/application/ports/authentication.ts / src/app.ts(/authorize・resolveExternalTokenForMcp)
