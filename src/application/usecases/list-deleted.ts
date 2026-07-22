// =============================================================================
// ListDeleted ユースケース — R2 ソフトデリートのゴミ箱一覧(docs/modeling/15 §A-3 R2)
// =============================================================================
//
// owner 配下の soft-delete 済みリソース(tombstone)を列挙する。DAV には露出せず MCP-only
// (list-deleted ツール)で使う「ゴミ箱ビュー」。プロトコル純度的にはこれが正攻法
// (docs/next-directions.md「R2 RFC 検証完了」: trash を DAV に出さず MCP-only にするのは
//  Nextcloud の独自 DAV 拡張と比べても正攻法)。
//
// 【なぜ薄い UC か】ポート(resourceRepo.listDeleted)が既に「削除済み行 + collectionId +
// deletedAt」を返すので、この UC は「resource から uri/uid/summary を取り出して整形」するだけ。
// summary の抽出(componentKind ごとに events/todos/journals の先頭を見る)を presentation に
// 漏らさず application に閉じるための存在意義がある(MCP/REST/メール等どの入口からも同じ形で
// ゴミ箱を引ける — CLAUDE.md 長期ビジョン1)。
// =============================================================================

import type { PrincipalRef } from "../../domain/caldav";
import type { CalendarObjectResource } from "../../domain/caldav";
import type { CalendarObjectResourceRepository } from "../ports";

// --- 入力 DTO ---

export interface ListDeletedInput {
	owner: PrincipalRef;
}

// --- 出力 DTO ---

/** ゴミ箱の1エントリ(復元 UI が表示する最小情報)。 */
export interface DeletedEntry {
	/** 削除済みリソースの現在の uri(restore-deleted に渡す復元キー)。 */
	uri: string;
	/** 所属コレクション ID(restore-deleted の calendarId)。 */
	calendarId: string;
	/** リソースの UID。 */
	uid: string;
	/** コンポーネント種別(VEVENT/VTODO/VJOURNAL)。UI がアイコン等の出し分けに使う。 */
	componentKind: string;
	/** タイトル(SUMMARY)。無ければ undefined。 */
	summary?: string;
	/** 削除時刻(エポック ms)。「いつ消したか」の表示に使う。 */
	deletedAtMillis: number;
}

export interface ListDeletedOutput {
	entries: DeletedEntry[];
}

/**
 * CalendarObjectResource から SUMMARY を取り出す(componentKind ごとに先頭コンポーネントを見る)。
 * マスター/オーバーライドが複数あっても「代表1件」の summary で十分(ゴミ箱の一覧表示用途)。
 */
function summaryOf(resource: CalendarObjectResource): string | undefined {
	switch (resource.componentKind) {
		case "VEVENT":
			return resource.payload.events()[0]?.summary;
		case "VTODO":
			return resource.payload.todos()[0]?.summary;
		case "VJOURNAL":
			return resource.payload.journals()[0]?.summary;
		default:
			return undefined;
	}
}

export class ListDeleted {
	constructor(private readonly resourceRepo: CalendarObjectResourceRepository) {}

	async execute(input: ListDeletedInput): Promise<ListDeletedOutput> {
		const deleted = await this.resourceRepo.listDeleted(input.owner);
		return {
			entries: deleted.map((d) => ({
				uri: d.resource.uri,
				calendarId: d.collectionId,
				uid: d.resource.uid,
				componentKind: d.resource.componentKind,
				summary: summaryOf(d.resource),
				deletedAtMillis: d.deletedAtMillis,
			})),
		};
	}
}
