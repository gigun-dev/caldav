// =============================================================================
// presentation/mcp/ui/card-version.ts — カードの版(バンドル/HTML ハッシュ)不整合の可視化(④)
// =============================================================================
// 【背景(2026-07-23 実害「今日の古い UI 混乱」)】claude.ai はコネクタ同期時点のツール定義
// (_meta.ui.resourceUri = content-hash 付き ui:// URI)をキャッシュし、サーバーをデプロイして
// 新 URI を発行しても、旧 URI(=旧カード HTML)を掴んだまま描画し続けることがある(SEP-1865 が MAY で
// 許可するキャッシュ)。結果、ユーザーは「直したはずの UI が古いまま」という混乱に陥る。
//
// 【対策の骨子】カードは配信 HTML に「自身の版ハッシュ」を焼き込んでおき(injectCardBuildHash)、
// サーバーは view model に「現行デプロイの版ハッシュ」(uiHash)を additive に載せる。カードは自身の
// 焼き込みハッシュと uiHash を突き合わせ(cardVersionIsStale)、食い違えば控えめな1行で「カードが古い
// 可能性 — コネクタを再同期してください」と告げる。誤検知を避けるため、どちらか欠落時は不整合と
// 判定しない(古いサーバー/古いカード/テストフィクスチャは uiHash や焼き込みが無いので静かに無効化)。
//
// 【なぜ URI hash(= fnv1aHex(app HTML))をそのまま版ハッシュに使い、bundle だけの hash にしないか】
// カードの陳腐化は entry(バンドル)だけでなく CSS/骨格(*-app.ts)の変更でも起こる。両方を含む「配信
// HTML 全体の hash」を版ハッシュにすれば取りこぼしが無い。**循環はしない**: 版ハッシュは「注入前の
// core HTML」から算出し、その値を注入した最終 HTML の hash を取り直さない(URI も core の hash を使う)。
// 注入で最終 HTML は変わるが、版ハッシュは core 由来で決まるので一意に定まる(todos-app.ts 参照)。
// =============================================================================

/**
 * 配信 HTML(core)に「自身の版ハッシュ」を `window.__CARD_BUILD_HASH__` として注入する。
 * `<head>` 直後に classic `<script>` を差し込む — module script(deferred)より先に実行されるので、
 * entry が読む時点で必ずセット済みになる。
 *
 * @param coreHtml 版ハッシュ注入前の HTML(CSS+骨格+inline バンドルを含む完成形)。
 * @param hash 焼き込む版ハッシュ(通常 fnv1aHex(coreHtml))。
 */
export function injectCardBuildHash(coreHtml: string, hash: string): string {
	const marker = "<head>";
	const idx = coreHtml.indexOf(marker);
	// core が想定どおり <head> を持たない(テンプレ破損)ときは握りつぶさず、注入せずそのまま返す。
	// URI hash 自体は core から別途算出済みでカードは動くので、版表示だけを安全に無効化する degrade。
	if (idx === -1) return coreHtml;
	const at = idx + marker.length;
	const inject = `\n<script>window.__CARD_BUILD_HASH__=${JSON.stringify(hash)};</script>`;
	return coreHtml.slice(0, at) + inject + coreHtml.slice(at);
}

/**
 * カード自身の版ハッシュ(焼き込み)とサーバーが返す現行版ハッシュ(uiHash)が食い違うか。
 * どちらか欠落(undefined/null/空文字)時は **false**(誤検知回避 = 欠落時は不整合を主張しない)。
 */
export function cardVersionIsStale(
	cardHash: string | undefined | null,
	serverHash: string | undefined | null,
): boolean {
	if (cardHash === undefined || cardHash === null || cardHash === "") return false;
	if (serverHash === undefined || serverHash === null || serverHash === "") return false;
	return cardHash !== serverHash;
}
