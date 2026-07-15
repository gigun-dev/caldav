// =============================================================================
// presentation/mcp/ui/icons.ts — lucide アイコンのインライン SVG(自己完結バンドル方針)
// =============================================================================
// 【なぜ npm の lucide / lucide-react を依存に足さないか】
//   このディレクトリは「自己完結バンドル」方針(todos-entry.ts 冒頭コメント)を取っており、
//   実行時ネットワーク import はもちろん、バンドルサイズ・監査容易性のためにビルド時の
//   外部依存も @modelcontextprotocol/ext-apps だけに絞っている。lucide 本体は SVG 1本あたり
//   数百バイトの path データでしかないので、パッケージを1本丸ごと引き込む代わりに「実際に
//   使うアイコンの path データだけ」を手で書き写して定数化する(tree-shaking に頼らず
//   最初から使う分だけ、という判断)。
//
// 【出典・ライセンス】
//   path データは https://lucide.dev (ISC License, Copyright (c) 2022 Lucide Contributors) から
//   該当アイコンの SVG ソースを目視で書き写したもの。ISC は再配布時の著作権表示を要求するため、
//   このファイルにライセンス表示を残す(コード自体は改変していない = 各アイコンの `<path>` 等の
//   要素をそのまま DOM 生成コードへ落とし込んだだけ)。
//
// 【2026-07-15 導入経緯】
//   絵文字(≡ ⟳ 📍 ⓘ ‹ › ⌄ ⌃ ＋ ✓)がプラットフォームごとにグリフ・太さ・整列が揺れ、
//   「ハンバーガーメニューみたいで気になる」というユーザーフィードバックを受けて置換した。
//   絵文字はフォント依存(iOS/Android/デスクトップで字形が異なる)なのに対し、インライン SVG は
//   1em 基準で stroke=currentColor にしておけば周囲のテキスト色・サイズに厳密に追従し、
//   見た目がどの環境でも一致する(絵文字よりむしろ制御しやすい)。
//
// 【サイズ規約】lucide 標準の 24x24 viewBox / stroke-width 2 / round cap・join をそのまま踏襲し、
//   width/height を "1em" にして周囲の font-size に自動追従させる(CSS 側で追加のサイズ指定は
//   基本不要 — 個別に大きくしたい箇所だけ font-size で調整する)。

/** 使用するアイコンの path/shape データ。要素種別ごとに tag と属性を持つ最小表現。
 *  lucide の SVG ソースをほぼそのまま(d 属性等)書き写しているだけで、独自の座標計算はしない。 */
interface IconShape {
	tag: "path" | "circle" | "line" | "polyline" | "rect";
	attrs: Record<string, string>;
}

// 【アイコン選定メモ(タスクの指示どおり)】
//  - text ではなく sticky-note ではなく「text」を採用: note-mark はタイトル末尾に小さく添える
//    インジケータで、視認性より「行の高さを乱さない華奢さ」を優先した。sticky-note は面積が
//    大きく☑チェック行の密なリストでは浮いて見えたため、横線3本の text にした(2026-07-15)。
const ICONS: Record<string, IconShape[]> = {
	// note-mark(メモありインジケータ)。lucide "text": 3本の横線。
	text: [
		{ tag: "path", attrs: { d: "M17 6.1H3" } },
		{ tag: "path", attrs: { d: "M21 12.1H3" } },
		{ tag: "path", attrs: { d: "M15.1 18H3" } },
	],
	// 繰り返しバッジ・繰り返し行。lucide "repeat"。
	repeat: [
		{ tag: "path", attrs: { d: "m17 2 4 4-4 4" } },
		{ tag: "path", attrs: { d: "M3 11v-1a4 4 0 0 1 4-4h14" } },
		{ tag: "path", attrs: { d: "m7 22-4-4 4-4" } },
		{ tag: "path", attrs: { d: "M21 13v1a4 4 0 0 1-4 4H3" } },
	],
	// 場所チップ・場所行。lucide "map-pin"。
	"map-pin": [
		{
			tag: "path",
			attrs: {
				d: "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
			},
		},
		{ tag: "circle", attrs: { cx: "12", cy: "10", r: "3" } },
	],
	// 行の info ボタン(詳細シートを開く)。lucide "info"。
	info: [
		{ tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
		{ tag: "path", attrs: { d: "M12 16v-4" } },
		{ tag: "path", attrs: { d: "M12 8h.01" } },
	],
	// ページヘッダの「戻る」・リスト選択ページの戻る。lucide "chevron-left"。
	"chevron-left": [{ tag: "path", attrs: { d: "m15 18-6-6 6-6" } }],
	// リスト行の遷移矢印(› → リスト選択ページ)。lucide "chevron-right"。
	"chevron-right": [{ tag: "path", attrs: { d: "m9 18 6-6-6-6" } }],
	// 繰り返し行の開閉(閉じている状態)。lucide "chevron-down"。
	"chevron-down": [{ tag: "path", attrs: { d: "m6 9 6 6 6-6" } }],
	// 繰り返し行の開閉(開いている状態)。lucide "chevron-up"。
	"chevron-up": [{ tag: "path", attrs: { d: "m18 15-6-6-6 6" } }],
	// FAB の追加ボタン。lucide "plus"。
	plus: [
		{ tag: "line", attrs: { x1: "12", x2: "12", y1: "5", y2: "19" } },
		{ tag: "line", attrs: { x1: "5", x2: "19", y1: "12", y2: "12" } },
	],
	// チェック円の完了マーク・リスト選択ページの現在地マーク。lucide "check"。
	check: [{ tag: "path", attrs: { d: "M20 6 9 17l-5-5" } }],
	// アジェンダ(E-3 S2)の「参加(ビデオ通話)」行・URL があるイベント行の video アイコン。lucide "video"。
	video: [
		{
			tag: "path",
			attrs: {
				d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
			},
		},
		{ tag: "rect", attrs: { x: "2", y: "6", width: "14", height: "12", rx: "2" } },
	],
};

/**
 * lucide アイコンを SVGSVGElement として生成する(createElementNS。innerHTML は使わない —
 * このモジュールの静的データしか流し込まないので XSS リスクは無いが、既存コードベースが
 * 一貫して createElement 系で DOM を組む素の DOM 操作方針(todos-entry.ts 冒頭コメント)に
 * 揃えるため)。
 * @param name ICONS のキー
 * @param opts.label 付けると aria-hidden をやめて role="img" + aria-label にする(SVG 自体が
 *   意味を持つ稀なケース用。既定は aria-hidden="true" — 隣接するテキスト/aria-label 済みの
 *   親ボタンが意味を担うため、装飾アイコンとして読み上げから隠す)。
 */
export function createIcon(name: keyof typeof ICONS, opts?: { label?: string }): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "1em");
	svg.setAttribute("height", "1em");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.classList.add("lucide-icon");
	if (opts?.label !== undefined) {
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", opts.label);
	} else {
		svg.setAttribute("aria-hidden", "true");
	}
	for (const shape of ICONS[name]) {
		const el = document.createElementNS("http://www.w3.org/2000/svg", shape.tag);
		for (const [k, v] of Object.entries(shape.attrs)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
	return svg;
}
