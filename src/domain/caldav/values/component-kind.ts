// =============================================================================
// ComponentKind — カレンダーが扱うコンポーネント種別(値オブジェクト)
// =============================================================================
//
// CalDAV のコレクションは「どのカレンダーコンポーネント型を格納するか」を
// supported-calendar-component-set(RFC 4791 §5.2.3)で宣言する。iOS はカレンダー用
// コレクションに VEVENT、リマインダー用コレクションに VTODO を要求する。
//
// 【なぜこの3種か(VEVENT / VTODO / VJOURNAL)】
// - VJOURNAL: 2026-07-11 の方向性 J(09 §4a「agentic な日誌」)で追加。iOS 標準アプリは
//   VJOURNAL の UI を持たないが、RELATED-TO で VTODO/VEVENT へ紐付く「日誌エントリ」として
//   agentic なタスク管理基盤(CLAUDE.md の長期ビジョン①)の本丸になる。旧コメントは
//   「iOS 非対応だからスコープ外」としていたが、iOS 対応はコア価値の1つであって唯一の
//   駆動力ではない(CLAUDE.md: コア価値は「RFC 準拠 + iOS 対応」の両輪)。J-1 でまず
//   格納・検証・往復ができるところまで実装し(コレクション provision や time-range
//   フィルタは J-2/J-4 に送る。put-preconditions.ts の checkSupportedComponent と
//   occurrence-bounds.ts の computeVJournalBounds のコメント参照)。
// - VFREEBUSY: スケジューリング(将来フェーズ)専用で、コレクションの格納対象ではない。
// - VTIMEZONE: リソース内の補助コンポーネントであって「リソースの種別」ではない
//   (R1/R3 で常に除外される。ここには現れない)。
// よって「コレクションが受け入れる種別 = リソースの主コンポーネント種別」は VEVENT|VTODO|VJOURNAL。
//
// 【拡張可能に】将来さらに種別を足すときは COMPONENT_KINDS 配列に1語加えるだけで
// 型・ガード・パーサが追従するよう、配列を single source of truth にしている。
// =============================================================================

// as const で読み取り専用タプル化し、型を配列から導出する(値と型の二重定義を避ける)。
export const COMPONENT_KINDS = ["VEVENT", "VTODO", "VJOURNAL"] as const;

/** "VEVENT" | "VTODO" | "VJOURNAL"。配列 COMPONENT_KINDS から導出。 */
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * 任意文字列が ComponentKind か判定する型ガード。
 * iCalendar のコンポーネント名は case-insensitive(RFC 5545 §3.1)で、structure 層が
 * 既に大文字正規化して保持している。ここへ来る値は通常大文字だが、外部入力
 * (supported-calendar-component-set の XML 属性等)も想定して大文字化してから照合する。
 */
export function isComponentKind(name: string): name is ComponentKind {
	return (COMPONENT_KINDS as readonly string[]).includes(name.toUpperCase());
}

/**
 * 文字列 → ComponentKind(不正なら undefined)。
 * VEVENT/VTODO/VJOURNAL 以外(VFREEBUSY 等 = 現状未サポート)を undefined で返し、
 * 呼び出し側が supported-calendar-component 違反として扱えるようにする。
 */
export function parseComponentKind(name: string): ComponentKind | undefined {
	const upper = name.toUpperCase();
	return isComponentKind(upper) ? (upper as ComponentKind) : undefined;
}
