// Wrangler は secret 名を設定ファイルから生成できないため、生成済み CloudflareBindings に
// secret binding だけを declaration merging で追加する。DB/vars/runtime API は
// worker-configuration.d.ts が source of truth であり、ここへ手書きしない。
interface CloudflareBindings {
	CALDAV_PASSWORD: string;
	PROXY_SHARED_SECRET: string;
	// iOS 実機検証用のキャプチャログを有効化するゲート(var)。"1" で有効。
	// 検証時のみ有効化する。通常は 0(または未設定)。旧名 CAPTURE_LOG(2026-07-11 改名)。
	// vars なので worker-configuration.d.ts が本来の source of truth だが、
	// wrangler types 再生成前でも tsc を通すためここに任意 var として足しておく。
	DUMP_DAV_REQUESTS?: string;
}
