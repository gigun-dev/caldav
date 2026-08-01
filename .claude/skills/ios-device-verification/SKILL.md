---
name: ios-device-verification
description: iOS 実機/Simulator(カレンダー/リマインダーアプリ)でこの CalDAV サーバーを検証する手順。実機検証・iPhone 接続・tunnel/proxy/dev の起動・接続情報の組み立て・iOS 26 のアカウント追加経路を頼まれたときに使う。Simulator へ本サーバーを登録するときの前提(ユーザー追加アカウントが1つも無い端末では初回追加が必ず失敗する)と .mobileconfig が Simulator で効かない事実もここ。
---

# iOS 実機検証

## 実機の前に: iOS Simulator でも検証できる(2026-07-22 / 条件を 2026-08-02 追記)

- Simulator に本サーバーを CalDAV アカウントとして登録すれば、標準アプリでのサーバー検証
  (URL/CONFERENCE 表示・通知・移動時間など)は **Simulator で自走できる**(実機必須ではない)。
  接続情報の組み立ては下記と同じ。**ただし下記 ⚠️ の前提を満たした端末に限る。**
- 実機だけが必要なのは、push 系・実機固有の挙動(省電力・バックグラウンド同期の実タイミング等)を
  見たいときのみ。

### ⚠️ 前提: **ユーザー追加アカウントが1つも無い Simulator では、本サーバーの登録は必ず失敗する**

**まっさらな Simulator では CalDAV アカウントの初回追加が必ず失敗する**(2026-08-01 実測)。
サーバー検証は通るのに「カレンダー/リマインダー」トグル一覧が空になり、保存すると
**データクラス0個の「停止中」アカウント**ができる。**他社サーバー(Vikunja のデモ)でも再現**したので、
**本サーバーの実装は無関係**。→ **ここでサーバー側のデバッグに入ってはいけない。**

回避策は「CalDAV を追加する前に `webcal://` で照会カレンダーを1つ入れて端末を温める」
(4タップ・テキスト入力ゼロ)。**Simulator にアカウントを入れる作業を始める前に**、
共有スキル `ios-simulator` の「まっさらな Simulator では CalDAV アカウントの初回追加が必ず失敗する」節と
`references/state-provisioning.md` §4 を読むこと(温めの正確な手順・`Accounts3.sqlite` での判定・
種を1台作ってからの `simctl clone` 量産まで、原典はすべて向こうにある)。

> **「検証済み」の前提を明示する(2026-08-02 追記)**: 下の「iPhone 17 / iOS 26.4 Simulator で
> 登録成功」は、**その端末に既にユーザー追加アカウントが1つ以上あった**ために成立した記録。
> 当時はそれが成功条件だと気づいておらず、「Simulator でいける」とだけ読める書き方をしていた。
> 実際 2026-08-01 に別エージェントがこの記述を根拠に新品端末で着手して失敗している。
> **記録自体は消さず(嘘ではない)、成立条件を添えて残す。**

### アカウント追加の経路 — **iOS 26 で変わった**(2026-07-31 更新・実機確認済み)

```
設定 → アプリ → カレンダー → 「アカウントを追加…」
  → ★「リストから選択します。」        ← iOS 26 で挟まった段
  → その他のアカウントを追加… → CalDAVアカウント
  → サーバ / ユーザ名 / パスワード / 説明
```

**★の落とし穴**: iOS 26 の「アカウントを追加」は**まずメールアドレスを訊いてプロバイダを
自動判別しようとする**。判別に失敗すると
「⚠ サーバとの通信で問題が起きました。アカウントプロバイダにサインインするか、
**リストから選択します。**」と出る。**これはエラーに見えるが正常な分岐**で、
青リンク「リストから選択します。」がプロバイダ一覧への唯一の入口。
ここで詰まると CalDAV に辿り着けない。

> **旧記載(〜iOS 18 想定)**: 「設定 → カレンダー → アカウント追加 → その他 → CalDAV」。
> iOS 26 では ①カレンダー設定が **設定 > アプリ** 配下へ移動 ②上記の自動判別段が挟まる、
> の2点で経路が変わった。旧記載のままだと辿り着けないので**削除せず差分として残す**。

**検証済み**: iPhone 17 / iOS 26.4 Simulator、`caldav.gigun-dev.workers.dev` へ Basic 認証で登録成功
(⚠️ 上記のとおり **既存アカウントがあった端末**での記録)。

**要素の識別子は言語設定に依存しない**(2026-08-01 実測: 端末を英語に切り替えてラベルが全部英語に
なっても `idb ui describe-all` の `AXUniqueId` 集合は diff ゼロ)。日本語ラベルでタップ先を
探して外すくらいなら、この chain を辿るほうが速い:

```
com.apple.settings.apps → com.apple.mobilecal → ACCOUNTS → ADD_ACCOUNT
  → (ここから先は AXUniqueId が無い)ラベル「その他のアカウントを追加…」→「CalDAVアカウント」
```

> **Why not 共有スキル側に置かないか**: この chain は「本サーバーを iOS に登録する」ための経路で、
> CalDAV 固有(`com.apple.mobilecal` 配下)なので本スキルが持つ。共有スキル `ios-simulator` 側に
> 同じ chain が入ったら、**本節は消してポインタに畳むこと**(重複させない)。

### エージェントが Simulator を CLI 操作するときの注意

### 🔴 アプリを触る前に、これを実行する(読むのではなく実行する)

```bash
export SIM_UDID=<対象の UDID>          # 端末を新しく作るなら create → bootstatus を先に
networksetup -getsecurewebproxy "Wi-Fi"                        # Enabled: Yes なら HTTPS が全部 MITM される
pgrep -lf 'Proxyman|Charles|mitmproxy'                         # キャプチャツールが動いていないか
defaults read com.apple.iphonesimulator ConnectHardwareKeyboard # 1 ならソフトキーボードが出ない
xcrun simctl list devices booted                               # 複数 Booted なら以降すべて UDID 明示
```

**新品 Simulator はキャプチャツールのルート CA を信頼していないので、HTTPS だけが静かに落ちる。**
この失敗はこう見える(**grep で当たるよう原文のまま置く**):

```
NSURLErrorDomain Code=-1200 "A TLS error caused the secure connection to fail."
# Safari では: 接続はプライベートではありません / サーバの識別情報を検証できません
```

対処は**その端末にだけ CA を入れる**(ホストのプロキシ設定は触らない):
`<ios-simulator スキル>/scripts/sim-trust-ca.sh --udid "$SIM_UDID"`(冪等・`--dry-run` あり)

> **Why not「共有スキルの事前チェック節を実行せよ」で済ませないか(2026-08-02 実測で改訂)**:
> 以前はそう書いていた。**エージェントはその一文を読んだうえで実行せず、7分目に TLS で詰まった**
> (本人の弁: 「していれば1分目に気づいていた」)。**ポインタは読ませられても実行させられない。**
> 逆に、同じチェックを**コマンドごとインライン化した run は、共有スキルを一度もロードせずに
> 事前チェックを実行した**(✅実測)。**だからここに実物を置く。ポインタに戻さないこと。**
> 共有スキルが読まれるかは 78%(9 run 実測)で、**制御できない**。

操作手順・座標系・IME 化け・スクショの出力先といった汎用の規律は**すべて共有スキル `ios-simulator`
が原典**。本スキルでは重複させない —— **ただし上の事前チェックだけは例外**(実行率を上げるため
意図的に重複させている。片方だけ更新されて食い違うリスクより、実行されないリスクの方が大きい)。

## 前提(重要)

- **Claude の実行環境では常駐プロセス(dev/proxy/tunnel)を起動しない**(Makefile 冒頭の注記)。
  起動はユーザーの端末で行う。Claude の仕事は「起動コマンド・接続情報・期待結果」を
  **セットで**ユーザーに渡すこと(「実機で試して」だけで終わらせない)。

## 構成(3プロセス)

```
iPhone → cloudflared named tunnel(固定 URL)→ 書き換え proxy :8080 → wrangler dev :8787
```

proxy は workerd が通せない MKCALENDAR を書き換えるために必須。

## ユーザーに渡す起動手順

1. `make up`(dev+proxy+tunnel を1ターミナルでまとめて起動。個別なら別ターミナルで
   `make dev` / `make proxy` / `make tunnel`)
   - 全リクエストダンプが要る調査なら `make up DUMP=1`
2. 初回またはローカル D1 リセット後: `make migrate-local` → `make seed`(dev 起動中に)
3. iOS アカウント設定を楽にするなら `make mobileconfig` で .mobileconfig 生成
   - ⚠️ **実機専用。Simulator では .mobileconfig からアカウントは作られない**(2026-08-01 実測。
     インストールは「完了」まで行くのに `Accounts3.sqlite` に行が増えない。CalDAV 固有ですらなく、
     **アカウント系ペイロード全般**が Simulator では効かない)。**Simulator に対しては
     「プロファイルを入れたから入ったはず」と UI で判定しないこと。** Simulator へ状態を運ぶ手段は
     共有スキル `ios-simulator` の `references/state-provisioning.md`(env 注入 / `simctl clone`)。

## 接続情報として必ず添えるもの

- サーバー URL: cloudflared/config.yml の named tunnel 固定 URL(https)
- 認証: Basic(ユーザー名 + `.dev.vars` の CALDAV_PASSWORD)
- 検証したい操作の具体的な手順(例: カレンダー追加 → 予定作成 → 同期確認)と**期待結果**
- 失敗時に見るログ(`make up | grep '\[dev\]'` など)

## 結果の記録

- 実機挙動の検証結果は **docs/modeling/06** に記録する(既存3ラウンドの形式に倣う)。
