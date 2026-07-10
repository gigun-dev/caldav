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
// 検証用は固定 UUID にして常に置き換えにする(アカウントが増殖しない)。
const PROFILE_UUID = "7B2A4C1E-0000-4000-8000-C0FFEE000001";
const PAYLOAD_UUID = "7B2A4C1E-0000-4000-8000-C0FFEE000002";

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
			<string>dev.gigun.caldav.account</string>
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
	<string>dev.gigun.caldav.profile</string>
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

const out = process.argv[2] ?? "caldav-verification.mobileconfig";
await Bun.write(out, profile);
console.log(`書き出し完了: ${out}`);
console.log(`  host=${host} user=${username} desc=${description}`);
console.log("iPhone へは AirDrop で送る → 設定 → 一般 → VPN とデバイス管理 → インストール");
