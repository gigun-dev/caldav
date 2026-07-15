// =============================================================================
// mcp/events-view-model — event 系ツールの structuredContent 契約(E-3 スライス S1)
// =============================================================================
//
// 【この型が担うもの・TodosViewModel との対称】
// list-events-expanded(参照系)と create/update/delete-event(mutate 系)が共通で返す
// structuredContent の形。S2 のアジェンダカード(ui://caldav/agenda.html)がこれを読み、
// 前回描画との becoming 差分(追加が入ってくる・削除が抜けていく・編集でフィールドが変わる)を描く。
// TodosViewModel と同じ additive 契約(docs/modeling/12 §3)。
//
// 【なぜ presentation 層に置くか】TodosViewModel と同じ理由 — これは「MCP ツールが返す
// structuredContent の形」= プロトコル表現そのもの。application 層の Event DTO(意味的な
// イベント表現)とは別レイヤーの「UI 契約」。application 層は affected/removed のような
// 「MCP UI がどう差分を描くか」を知らない(複数入口方針)。
//
// 【range が「view echo」で mutate では欠落する理由(重要な判別シグナル)】
// TodosViewModel.view と同役割: list-events-expanded は「この一覧はどの期間か」を range に echo し、
// カードが currentRange として保持して focus refetch / mutation 後の再取得へ引き継ぐ。mutate 応答
// (create/update/delete-event)は range を名乗らない = 「これはビュー結果ではなく mutate 結果」の
// 判別シグナル(TodosViewModel の view 欠落と同じ意味論)。カードは range の有無で両者を見分ける。
// =============================================================================

import type { Event } from "../../application/usecases";

/**
 * 差分レンズ用の自己完結スナップショット(TaskSnapshot と対称)。mutate で影響を受けた行を、
 * 確定一覧を参照せず単体で描き切れる表示用データ。
 */
export interface EventSnapshot {
	id: string;
	title: string;
	/** 表示用の開始短文("YYYY-MM-DD" or "YYYY-MM-DD HH:MM")。生 ISO ではない。無ければ省略。 */
	start?: string;
	/** 表示用の終了短文。無ければ省略。 */
	end?: string;
	/** LOCATION。未設定は省略。 */
	location?: string;
	isAllDay?: boolean;
}

/**
 * mutate によって影響を受けた 1 イベントの差分メタ(AffectedTask と対称)。
 * イベントに完了は無いので kind は added/edited のみ(completed/reopened は持たない)。
 */
export interface AffectedEvent {
	id: string;
	kind: "added" | "edited";
	/** 対象イベントの表示用スナップショット(一貫性のため常に添える)。 */
	event?: EventSnapshot;
	/**
	 * kind:"edited" のフィールド単位の差分。start/end/location は短文 before/after、
	 * notes/recurrence は field のみ(長い/表現が割れる値は UI の「編集済み」バッジへ degrade)。
	 */
	changes?: Array<{ field: string; before?: string; after?: string }>;
}

/**
 * event 系ツールの structuredContent。events は list-events-expanded なら展開済み occurrence 列、
 * mutate なら「影響したイベント(マスター単位)」。affected/removed/range は additive(TodosViewModel と同じ)。
 */
export interface EventsViewModel {
	events: Event[];
	calendarId: string;
	timeZone: string;
	/** mutate 系のみ。参照系(list-events-expanded)は付けない。 */
	affected?: AffectedEvent[];
	/** delete のみ。EventSnapshot に統一。 */
	removed?: EventSnapshot[];
	/**
	 * view echo(list-events-expanded のみ)。この一覧の期間(offset 付き ISO8601 の echo)。
	 * mutate 応答はこのキーを載せない(ファイル冒頭「判別シグナル」参照)。
	 */
	range?: {
		from: string;
		to: string;
	};
	/** list-events-expanded で occurrence 上限に達して結果が切り詰められたか(既存 truncated と同義)。 */
	truncated?: boolean;
}
