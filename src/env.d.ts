// Wrangler は secret 名を設定ファイルから生成できないため、生成済み CloudflareBindings に
// secret binding だけを declaration merging で追加する。DB/vars/runtime API は
// worker-configuration.d.ts が source of truth であり、ここへ手書きしない。
interface CloudflareBindings {
	CALDAV_PASSWORD: string;
	PROXY_SHARED_SECRET: string;
}
