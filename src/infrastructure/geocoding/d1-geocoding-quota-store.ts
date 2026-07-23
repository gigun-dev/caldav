// =============================================================================
// D1GeocodingQuotaStore — GeocodingQuotaStore の Cloudflare D1 実装(#45 月次 quota)
// =============================================================================
//
// 【テーブル】migrations/0005_geocoding_quota.sql の geocoding_quota(month TEXT PK, used INTEGER)。
// 月ごとに1行。月が変われば別 month キー = 別行 = 自動リセット(前月行は残るが害は無い・
// 監査で「先月何回叩いたか」が見える。TTL 掃除は YAGNI — 月12行/年しか増えない)。
//
// 【atomic な予約(reserve)の要】
// tryConsume は「used < limit のときだけ +1」を **単一 SQL 文**で行う。これがコーディネータ要件
// 「上限到達でブロック」「並行呼び出しでの単調増加」の肝:
//   INSERT INTO geocoding_quota(month, used) VALUES(?, 1)
//   ON CONFLICT(month) DO UPDATE SET used = used + 1 WHERE geocoding_quota.used < ?
//   RETURNING used
// - 行が無い初回 → INSERT で used=1、RETURNING が {used:1} を返す(1枠確保)。
// - 行があり used < limit → DO UPDATE で +1、RETURNING が新 used を返す(1枠確保)。
// - 行があり used >= limit → WHERE が false で DO UPDATE が空振り。**INSERT も CONFLICT で
//   実行されない**ため、この文は0行 = RETURNING 何も返さない(枠なし = ブロック)。
// D1 は1 prepare().bind().run()/all() を1トランザクションとして atomic に実行するので、
// 並行 tryConsume は SQLite の行ロックで直列化され、used は単調に増える(TOCTOU が構造的に無い)。
//
// 【なぜ read-then-write の2段にしないか(ボツ案・財産)】
// 「SELECT used → JS で判定 → UPDATE」だと、2つの並行リクエストが同じ used を読んで両方 +1 し、
// limit を1超えて課金 API を叩きうる(無料枠を守る目的そのものを裏切る)。条件付き UPSERT +
// RETURNING の1文なら判定と加算が不可分になる。D1(SQLite)は RETURNING と ON CONFLICT ... WHERE を
// どちらもサポートする(SQLite 3.35+/3.24+)。
// =============================================================================

import type { GeocodingQuotaStore } from "../../application/ports";

interface UsedRow {
	used: number;
}

export class D1GeocodingQuotaStore implements GeocodingQuotaStore {
	constructor(private readonly db: D1Database) {}

	async tryConsume(month: string, limit: number): Promise<{ ok: boolean; used: number }> {
		// ファイル冒頭の条件付き UPSERT。WHERE は DO UPDATE 側にだけ効く(INSERT 経路は常に成功)。
		// RETURNING used で「確保後の used」または「0行(ブロック)」を受け取る。
		const row = await this.db
			.prepare(
				`INSERT INTO geocoding_quota (month, used) VALUES (?, 1)
				 ON CONFLICT(month) DO UPDATE SET used = used + 1 WHERE geocoding_quota.used < ?
				 RETURNING used`,
			)
			.bind(month, limit)
			.first<UsedRow>();

		if (row === null) {
			// 0行 = used >= limit で予約できなかった。現在値は limit と等しい(上限に張り付いている)。
			// used を limit として返す(呼び出し側は ok:false しか見ないが、観測用に埋めておく)。
			return { ok: false, used: limit };
		}
		return { ok: true, used: row.used };
	}
}
