// =============================================================================
// CalDAV アカウント構成プロファイル(.mobileconfig)生成スクリプト
// =============================================================================
//
// 【目的】iOS に CalDAV アカウントを追加するとき、サーバー URL や App Password を
// 設定アプリで手打ちするのは苦行(特にランダムなパスワード)。Apple の構成プロファイル
// (com.apple.caldav.account ペイロード)を生成して AirDrop / URL 配布すれば、
// 「プロファイルを開く → インストール」の2タップでアカウントが生える。
// M2(マルチユーザー)ではダッシュボードからのワンタイム URL 配布を正式ルートにする
// 予定で、これはその前身となる開発用ツール(CLAUDE.md の M2 参照)。
//
// 【⚠️ 実機専用。iOS Simulator ではアカウントが作られない】(2026-08-01 実測で訂正)
//   Simulator ではインストールが「完了」まで到達し、設定アプリにもプロファイルが並ぶのに、
//   Accounts3.sqlite に行が1つも増えない。**CalDAV 固有ですらなく、アカウント系ペイロード全般**が
//   Simulator ではアカウントを作らない(認証の要らない com.apple.subscribedcalendar.account 単体でも
//   作られないことを確認済み。つまり「本サーバーへの接続に失敗しているから」ではない)。
//   → **Simulator 相手に「インストール完了」の UI を成功判定に使わないこと。**
//      判定は Accounts3.sqlite を直接見る。Simulator へ状態を運ぶ正しい手段(env 注入 /
//      種を1台作ってからの simctl clone)は共有スキル ios-simulator の
//      references/state-provisioning.md にある。
//   なお **実機では有効**(このスクリプトの存在意義は失われていない)ので、機能は変えない。
//
// 【使い方】
//   bun scripts/make-mobileconfig.ts [出力パス]
//   資格情報・ホストは環境変数で上書き可能(既定は検証アカウント):
//     CALDAV_HOST=caldav-proxy-....run.app CALDAV_USER=admin CALDAV_PASS=changeme \
//       bun scripts/make-mobileconfig.ts ~/Downloads/caldav.mobileconfig
//
// 【セキュリティ上の注意】
//   - パスワードはプロファイル内に**平文**で入る(Apple の仕様。デバイスへの
//     インストール後はキーチェーン管理になるが、ファイル自体は秘密として扱うこと)。
//     検証アカウント(admin/changeme — 公開前提の使い捨て)以外の値で生成した
//     ファイルはリポジトリにコミットしない・配布後は削除する。
//   - 未署名プロファイルなので iOS は「未署名」警告を出す(動作はする)。
//     署名は M2 でダッシュボード配布にするときに検討(Apple Developer 証明書 or
//     Let's Encrypt 証明書での S/MIME 署名)。
//
// 【ホストの既定が Cloud Run な理由】iOS の正式な接続先は MKCALENDAR 変換プロキシ
// (docs/modeling/06 の C1: workerd は MKCALENDAR を通せないため。workers.dev 直結だと
// 端末からの新規リスト作成ができない)。
// =============================================================================

// 既定値: 検証アカウント(2026-07-10 ユーザー決定: admin/changeme。公開 URL 上の
// 使い捨てアカウントなので推測可能な値で構わない、という割り切り)。
const host = process.env.CALDAV_HOST ?? "caldav-proxy-351824999564.asia-northeast1.run.app";
const username = process.env.CALDAV_USER ?? "admin";
const password = process.env.CALDAV_PASS ?? "changeme";
const description = process.env.CALDAV_DESC ?? "caldav 検証";

// PayloadUUID / PayloadIdentifier は「このプロファイルの同一性」を表す。
// 同じ UUID のプロファイルを再インストールすると「置き換え」になる(別 UUID だと併存)。
// 2026-07-11 変更: 完全固定 UUID だと本番用とローカル開発用(caldav-dev.097969.xyz)が
// 相互に置き換え合ってしまい併存できない。かといって毎回ランダムだと同じ接続先の
// プロファイルが増殖する。→ host+username の SHA-256 から決定的に導出する:
//   同じ接続先への再生成 = 同じ UUID = 置き換え(増殖しない)
//   別の接続先          = 別の UUID   = 併存(dev と prod を両方入れられる)
const idHash = new Bun.CryptoHasher("sha256")
	.update(`${host}\n${username}`) // 区切りは \n(host に現れない文字なら何でもよい)
	.digest("hex");
// hex 32桁を 8-4-4-4-12 に整形して UUID 形式にする(version/variant ビットは
// iOS は検査しないが、念のため RFC 4122 の v4/variant を立てておく)。
const toUuid = (hex: string) =>
	`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase();
const PROFILE_UUID = toUuid(idHash.slice(0, 32));
const PAYLOAD_UUID = toUuid(idHash.slice(32, 64));
// PayloadIdentifier も同一性判定に使われるため、接続先ごとに変える(先頭8桁で十分)。
const IDENT_SUFFIX = idHash.slice(0, 8);

// XML 特殊文字のエスケープ(パスワードに & や < が入っても壊れないように)。
const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Apple の構成プロファイルは plist XML。CalDAV ペイロードの必須キーは
// AccountHostName / Username。UseSSL true + Port 443 で https 接続になる。
const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>CalDAVAccountDescription</key>
			<string>${esc(description)}</string>
			<key>CalDAVHostName</key>
			<string>${esc(host)}</string>
			<key>CalDAVPort</key>
			<integer>443</integer>
			<key>CalDAVUseSSL</key>
			<true/>
			<key>CalDAVUsername</key>
			<string>${esc(username)}</string>
			<key>CalDAVPassword</key>
			<string>${esc(password)}</string>
			<key>PayloadDescription</key>
			<string>CalDAV アカウント設定</string>
			<key>PayloadDisplayName</key>
			<string>${esc(description)}</string>
			<key>PayloadIdentifier</key>
			<string>dev.gigun.caldav.account.${IDENT_SUFFIX}</string>
			<key>PayloadType</key>
			<string>com.apple.caldav.account</string>
			<key>PayloadUUID</key>
			<string>${PAYLOAD_UUID}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>${esc(description)}</string>
	<key>PayloadIdentifier</key>
	<string>dev.gigun.caldav.profile.${IDENT_SUFFIX}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${PROFILE_UUID}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;

// このファイルを ES モジュール扱いにして top-level await を許可する
// (import/export が1つも無いと tsc は script 扱いにし、TS1375 で落ちる)。
export {};

const out = process.argv[2] ?? "caldav-verification.mobileconfig";
await Bun.write(out, profile);
console.log(`書き出し完了: ${out}`);
console.log(`  host=${host} user=${username} desc=${description}`);
// 出力先にも「実機用」を書く。生成物だけ渡されたエージェント/人が Simulator に流し込んで
// ハマる事故(2026-08-01 に実際に起きた)を、ここでも1行止める。
console.log("iPhone(実機)へは AirDrop で送る → 設定 → 一般 → VPN とデバイス管理 → インストール");
console.log("※ iOS Simulator ではこのプロファイルからアカウントは作られない(実測)。冒頭コメント参照");
