// =============================================================================
// presentation/mcp/ui/location-view.ts — 場所 / 会議 / 参照 URL の「行に何を出すか」を決める純関数群
//                                          (C2・設計 05 §2 の3スロット意味モデルの描画側)
// =============================================================================
// 【このモジュールの位置づけ(fold.ts / format.ts と同じ規律)】
//   C1(structured-location.ts)が生 ICS から派生させた3スロット(場所 / 会議 / 参照 URL)を、
//   カード行に「どのバッジ/リンクを・どの文言で出すか」へ写す純関数だけを切り出す。DOM に一切
//   触れない(li の組み立て・アイコン付与・リンクの開き方は *-entry.ts 側が担う)ので、
//   swift-testing ではなく bun:test で DOM 無しに境界を固定できる(mcp-location-view.test.ts)。
//   fold.ts が「畳み判定」を、format.ts が「日付/時刻整形」を純関数化しているのと同じ流儀で、
//   ここは「場所/会議/参照の出し分け判断」を純関数化する。
//
// 【なぜ ui/ に置くか(domain/semantics ではなく)】
//   これは「読み取った意味値 → カード表示の判断」であって、生 ICS の解釈(それは C1 の
//   structured-location.ts が済ませた)ではない。表示判断はカード固有(inline は主要1つ+小さく、
//   fullscreen は全部、という設計 05 §4 の inline プレビュー方針)なので、契約の正(caldav domain)
//   ではなく描画レイヤ(ui/)の関心。ui/ は 'mcp-ui-is-terminal' で src/ 内 import を禁じられている
//   ため、C1 の型(StructuredLocation / ProximityAlarm / Conference)は下に写経する(*-entry.ts が
//   契約をローカル interface に写経するのと同じ割り切り。ズレは実機/テストで気づく前提)。
// =============================================================================

// -----------------------------------------------------------------------------
// C1 の派生型の写経(src/domain/ical/semantics/structured-location.ts と一致させること)
// -----------------------------------------------------------------------------

/** 構造化場所(structured-location.ts の StructuredLocation と同型)。 */
export interface StructuredLocationView {
	title: string | null;
	address: string | null;
	geo: { lat: number; lon: number } | null;
	radiusMeters: number | null;
}

/** proximity アラーム(structured-location.ts の ProximityAlarm と同型)。 */
export interface ProximityAlarmView {
	proximity: "ARRIVE" | "DEPART";
	location: StructuredLocationView;
}

/** 会議 / 参照 URL の判別結果(structured-location.ts の Conference と同型)。 */
export interface ConferenceView {
	url: string;
	source: "url" | "description";
}

// -----------------------------------------------------------------------------
// 場所タイトルの解決
// -----------------------------------------------------------------------------

/**
 * 行の 📍 に出す場所タイトルを決める(設計 05 §2「場所」スロット・C2 agenda 指示 1)。
 *
 * 【出し分け(指示どおり)】structuredLocation.title(「岐阜大学」等の表示名)を最優先で使い、
 * 無ければ既存の表示テキスト LOCATION(location)の**先頭行**へ degrade する。住所全文は inline に
 * 出さない(設計 05 §1-b: Apple は LOCATION に "岐阜大学\n501-1112\n岐阜県..." と住所複数行を畳んで
 * 入れてくるので、先頭行=施設名に相当することが多い。詳細=住所全文は詳細ページの責務)。
 * どちらも無ければ null(= 📍 を出さない)。
 *
 * @param structured C1 の structuredLocation(未設定は null)
 * @param location   既存の表示テキスト LOCATION(未設定は null)
 */
export function resolveLocationTitle(structured: StructuredLocationView | null, location: string | null): string | null {
	const title = structured?.title;
	if (title !== null && title !== undefined && title.trim() !== "") return title.trim();
	// LOCATION は "\n" 区切りの複数行(C1 で decode 済み=実改行)。先頭行だけを施設名として使う。
	if (location !== null && location.trim() !== "") {
		const firstLine = location.split("\n")[0]!.trim();
		if (firstLine !== "") return firstLine;
	}
	return null;
}

// -----------------------------------------------------------------------------
// agenda inline: 主要バッジの選択(📍タイトル or 🎥参加 のどちらか1つ)
// -----------------------------------------------------------------------------

/** agenda inline の行に出す「主要バッジ」1つ(設計 05 §4 の inline プレビュー方針: 情報過多にしない)。
 *  - conference: 🎥「参加」ボタン(会議がある行)
 *  - location  : 📍 タイトル(会議は無いが場所がある行)
 *  会議も場所も無ければ null。 */
export type AgendaInlineBadge = { kind: "conference" } | { kind: "location"; title: string } | null;

/**
 * agenda inline 行の主要バッジを選ぶ(C2 agenda 指示 4「📍タイトル or 🎥参加 のどちらか主要1つ」)。
 *
 * 【会議を場所より優先する理由】🎥参加 は「いまタップすれば会議に入れる」アクション性を持つのに対し、
 * 📍場所は参照情報。inline の限られた1スロットには、より行動につながる会議を優先して出す
 * (fullscreen では両方出してよい = 詳細ページで場所も参加も並べる。指示 4 後段)。会議が無い行では
 * 場所タイトルを出す。両方無ければ何も出さない(recurrence / 跨ぎ日など他の meta はそのまま)。
 *
 * @param conference C1 の conference(会議でない=参照 URL のままは null)
 * @param structured C1 の structuredLocation(未設定は null)
 * @param location   既存の表示テキスト LOCATION(未設定は null)
 */
export function agendaInlineBadge(
	conference: ConferenceView | null,
	structured: StructuredLocationView | null,
	location: string | null,
): AgendaInlineBadge {
	if (conference !== null) return { kind: "conference" };
	const title = resolveLocationTitle(structured, location);
	if (title !== null) return { kind: "location", title };
	return null;
}

// -----------------------------------------------------------------------------
// 参照 URL(🔗)を出すかの判定
// -----------------------------------------------------------------------------

/**
 * 「🔗 参照 URL」を独立リンクとして出すかを判定する(C2 agenda 指示 3・設計 05 §2「参照 URL」スロット)。
 *
 * url が非 null かつ **conference の source が "url" でない**とき true。conference.source === "url" の
 * ときは、その URL が既に「参加」ボタンに化けている(設計 05 §1-c: 単独会議リンクは Apple が URL に
 * 直入れする)ので、二重に出さない。source === "description" の会議(URL 側は message: 等の参照リンク)や
 * 会議なし(conference===null)で URL が残っているときは、参照リンクとして 🔗 を出す。
 *
 * 【message: 等の非 http も出す(指示 3)】ここでは URL のスキームで弾かない — message: スキーム等の
 * 生値もそのままリンクに渡す方向で判断し、実際に開けるか(navigation 可否)はホストの判断に委ねる
 * (設計 05 §2「message: スキーム等も生値で開く方向に渡す(開けるかはホスト判断)」)。
 */
export function showReferenceUrl(url: string | null, conference: ConferenceView | null): boolean {
	if (url === null || url.trim() === "") return false;
	return conference?.source !== "url";
}

// -----------------------------------------------------------------------------
// todos: proximity バッジの文言
// -----------------------------------------------------------------------------

/** proximity バッジの表示内容(todos の 📍「〜に到着時」メタ。C2 todos 指示 5)。
 *  - text: バッジ本文(📍 アイコンは DOM 側で付ける・ここは文言のみ)
 *  - aria: 支援技術向けラベル(📍 を「位置情報」と読み下す) */
export interface ProximityBadge {
	text: string;
	aria: string;
}

/**
 * proximity アラームからバッジ文言を作る(C2 todos 指示 5・6・設計 05 §1-a/§2)。
 *
 * title があれば「<title> に到着時 / から出発時」、無ければ「位置情報の通知」へ degrade する
 * (C1 の JSDoc「位置トリガーはあるが座標/名前が読めないを握りつぶさず可視化する」)。到着/出発は
 * proximity の 2 値(ARRIVE=到着時 / DEPART=出発時)。
 *
 * 【Task.structuredLocation との優先(指示 6・C1 残課題2の裁定)】場所は proximityAlarm.location を
 * 主とする(通知条件に紐づく場所が主)。よってこの関数は prox.location だけを見る — VTODO 直下の
 * structuredLocation にはフォールバックしない(裁定どおり proximityAlarm.location 優先。prox 側の
 * title が null なら素直に「位置情報の通知」へ落とす)。
 */
export function proximityBadge(prox: ProximityAlarmView): ProximityBadge {
	const title = prox.location.title;
	// ARRIVE=到着時 / DEPART=出発時。DEPART だけ厳密判定(C1 の readProximityAlarm と同じ倒し方 —
	// 想定外値は ARRIVE 側だが、ここに来る時点で型は 2 値 union に閉じているので単純比較で足りる)。
	const whenSuffix = prox.proximity === "DEPART" ? "から出発時" : "に到着時";
	if (title !== null && title.trim() !== "") {
		const t = title.trim();
		return { text: `${t}${whenSuffix}`, aria: `位置情報 ${t}${whenSuffix}` };
	}
	// degrade: 場所名が読めない位置リマインダー(座標だけ等)。存在自体は可視化する。
	return { text: "位置情報の通知", aria: "位置情報の通知" };
}
