// Wrangler は secret 名を設定ファイルから生成できないため、生成済み CloudflareBindings に
// secret binding だけを declaration merging で追加する。DB/vars/runtime API は
// worker-configuration.d.ts が source of truth であり、ここへ手書きしない。
interface CloudflareBindings {
	CALDAV_PASSWORD: string;
	PROXY_SHARED_SECRET: string;
	// iOS 実機検証用のキャプチャログを有効化するゲート(var)。"1" で有効。
	// 一時的な検証用途。検証完了後は CAPTURE_LOG=0(または未設定)で無効化する。
	// vars なので worker-configuration.d.ts が本来の source of truth だが、
	// wrangler types 再生成前でも tsc を通すためここに任意 var として足しておく。
	CAPTURE_LOG?: string;
}
