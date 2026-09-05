// =============================================================================
// mcp/output-schemas — MCP structuredContent の出力契約
// =============================================================================
//
// MCP SDK は outputSchema を宣言したツールの成功応答について、handler が返した
// structuredContent をこのスキーマで検証する。ここでは application DTO をそのまま
// 公開せず、presentation 層で実際に返す wire shape と差分レンズ付き ViewModel を
// 共有定義する。tools/list に載る JSON Schema と実行時バリデーションが同じ定義から
// 作られるため、説明だけの「推奨」表示で終わらず、返却値の契約も固定できる。
//
// object は passthrough にする。既存の ViewModel は additive に拡張する方針なので、
// 既知フィールドは厳密に型付けしつつ、JSON Schema の additionalProperties:false を
// 宣言して将来の後方互換な追加フィールドを拒否しないためである。SDK の出力検証は
// structuredContent 自体を変換せず、ここで未知フィールドを捨てる意図もない。自由形式の
// any schema を使う意図はなく、すべての現行フィールドとネスト構造をここで明示する。
// =============================================================================

import { z } from "zod";

/** Task / Event DTO が共有する RRULE の UI-ready 要約。 */
const recurrenceOutputSchema = z
	.object({
		frequency: z.string(),
		interval: z.number(),
		weekdays: z.array(z.string()).nullable(),
		count: z.number().nullable(),
		until: z.string().nullable(),
	})
	.passthrough();

/** X-APPLE-STRUCTURED-LOCATION から派生した値。 */
const structuredLocationOutputSchema = z
	.object({
		title: z.string().nullable(),
		address: z.string().nullable(),
		geo: z.object({ lat: z.number(), lon: z.number() }).nullable(),
		radiusMeters: z.number().nullable(),
	})
	.passthrough();

/** 到着/出発 VALARM から派生した位置リマインダー。 */
const proximityAlarmOutputSchema = z
	.object({
		proximity: z.enum(["ARRIVE", "DEPART"]),
		location: structuredLocationOutputSchema,
	})
	.passthrough();

/** DESCRIPTION/URL から派生した会議リンク。 */
const conferenceOutputSchema = z
	.object({
		url: z.string(),
		source: z.enum(["url", "description"]),
	})
	.passthrough();

/** list-todos 等が返す application Task の wire shape。 */
export const taskOutputSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		completed: z.boolean(),
		status: z.string().nullable(),
		due: z.string().nullable(),
		isAllDay: z.boolean(),
		priority: z.number(),
		percentComplete: z.number().nullable(),
		completedAt: z.string().nullable(),
		notes: z.string().nullable(),
		sortOrder: z.number().nullable(),
		location: z.string().nullable(),
		recurrence: recurrenceOutputSchema.nullable(),
		structuredLocation: structuredLocationOutputSchema.nullable(),
		proximityAlarm: proximityAlarmOutputSchema.nullable(),
		calendarId: z.string().optional(),
	})
	.passthrough();

/** mutate 差分レンズが tasks の外側に添える表示用スナップショット。 */
const taskSnapshotOutputSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		due: z.string().optional(),
		priority: z.string().optional(),
		isAllDay: z.boolean().optional(),
		calendarId: z.string().optional(),
	})
	.passthrough();

const affectedTaskOutputSchema = z
	.object({
		id: z.string(),
		kind: z.enum(["added", "completed", "reopened", "edited"]),
		task: taskSnapshotOutputSchema.optional(),
		changes: z
			.array(
				z
					.object({
						field: z.string(),
						before: z.string().optional(),
						after: z.string().optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

const deletedItemOutputSchema = z
	.object({
		uri: z.string(),
		calendarId: z.string(),
		title: z.string(),
		deletedAtMillis: z.number(),
	})
	.passthrough();

/** todo 系ツール共通の確定一覧 ViewModel。 */
export const todosViewModelOutputSchema = z
	.object({
		tasks: z.array(taskOutputSchema),
		calendarId: z.string().nullable(),
		timeZone: z.string(),
		affected: z.array(affectedTaskOutputSchema).optional(),
		removed: z.array(taskSnapshotOutputSchema).optional(),
		movedTo: z.string().optional(),
		view: z
			.object({
				includeCompleted: z.boolean().optional(),
				dueBefore: z.string().optional(),
				dueAfter: z.string().optional(),
			})
			.passthrough()
			.optional(),
		completedSummary: z
			.object({
				total: z.number(),
				recent: z.array(taskSnapshotOutputSchema),
				byCalendar: z.record(z.string(), z.number()),
			})
			.passthrough()
			.optional(),
		deletedItems: z.array(deletedItemOutputSchema).optional(),
		generatedAt: z.number().optional(),
		uiHash: z.string().optional(),
		highlightId: z.string().optional(),
	})
	.passthrough();

/** list-events-expanded 等が返す Event DTO + legacy alias の wire shape。 */
export const eventOutputSchema = z
	.object({
		id: z.string(),
		recurrenceId: z.string().nullable(),
		title: z.string(),
		start: z.string(),
		end: z.string().nullable(),
		isAllDay: z.boolean(),
		location: z.string().nullable(),
		url: z.string().nullable(),
		notes: z.string().nullable(),
		// application DTO は標準3値だが、他クライアント由来の未知 STATUS は
		// DTO の degrade 方針で文字列のまま返り得るため enum に狭めない。
		status: z.string().nullable(),
		recurrence: recurrenceOutputSchema.nullable(),
		alarms: z.array(z.number()),
		travelMinutes: z.number().nullable(),
		structuredLocation: structuredLocationOutputSchema.nullable(),
		proximityAlarm: proximityAlarmOutputSchema.nullable(),
		conference: conferenceOutputSchema.nullable(),
		// 旧 list-events-expanded 消費者向け additive alias。
		uid: z.string(),
		summary: z.string(),
		description: z.string().nullable(),
		calendarId: z.string(),
		isRecurring: z.boolean(),
	})
	.passthrough();

/** mutate 差分レンズが events の外側に添える表示用スナップショット。 */
const eventSnapshotOutputSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		start: z.string().optional(),
		end: z.string().optional(),
		location: z.string().optional(),
		isAllDay: z.boolean().optional(),
	})
	.passthrough();

const affectedEventOutputSchema = z
	.object({
		id: z.string(),
		kind: z.enum(["added", "edited"]),
		event: eventSnapshotOutputSchema.optional(),
		changes: z
			.array(
				z
					.object({
						field: z.string(),
						before: z.string().optional(),
						after: z.string().optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

/** event 系ツール共通の一覧/操作結果 ViewModel。 */
export const eventsViewModelOutputSchema = z
	.object({
		events: z.array(eventOutputSchema),
		// owner 横断の list/refresh は null、mutate は保存先 ID を返す。
		calendarId: z.string().nullable(),
		timeZone: z.string(),
		affected: z.array(affectedEventOutputSchema).optional(),
		removed: z.array(eventSnapshotOutputSchema).optional(),
		range: z
			.object({ from: z.string(), to: z.string() })
			.passthrough()
			.optional(),
		// list/refresh の calendarIds / resolvedRange は additive な応答フィールド。
		calendarIds: z.array(z.string()).optional(),
		resolvedRange: z
			.object({
				timeMin: z.string(),
				timeMax: z.string(),
				serverNow: z.string(),
				timeZone: z.string(),
			})
			.passthrough()
			.optional(),
		truncated: z.boolean().optional(),
		generatedAt: z.number().optional(),
		uiHash: z.string().optional(),
	})
	.passthrough();

export const getCurrentTimeOutputSchema = z
	.object({
		currentTime: z.string(),
		timeZone: z.string(),
		utc: z.string(),
		dayOfWeek: z.string(),
	})
	.passthrough();

export const freeBusyOutputSchema = z
	.object({
		timeZone: z.string(),
		busy: z.array(
			z
				.object({
					start: z.string(),
					end: z.string(),
					type: z.enum(["BUSY", "BUSY-TENTATIVE"]),
				})
				.passthrough(),
		),
		resolvedRange: z
			.object({
				timeMin: z.string(),
				timeMax: z.string(),
				serverNow: z.string(),
				timeZone: z.string(),
			})
			.passthrough(),
	})
	.passthrough();

const calendarComponentsOutputSchema = z.array(z.enum(["VEVENT", "VTODO", "VJOURNAL"]));

export const calendarsOutputSchema = z
	.object({
		calendars: z.array(
			z
				.object({
					id: z.string(),
					displayName: z.string(),
					components: calendarComponentsOutputSchema,
					color: z.string().optional(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export const calendarPropertiesOutputSchema = z
	.object({
		id: z.string(),
		displayName: z.string(),
		components: calendarComponentsOutputSchema,
		color: z.string().optional(),
	})
	.passthrough();

export const calendarDeletedOutputSchema = z
	.object({ id: z.string(), deleted: z.literal(true) })
	.passthrough();

export const knownLocationsOutputSchema = z
	.object({
		locations: z.array(
			z
				.object({
					title: z.string(),
					address: z.string().nullable(),
					lat: z.number(),
					lon: z.number(),
					radius: z.number().nullable(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export const searchLocationOutputSchema = z
	.object({
		candidates: z.array(
			z
				.object({
					title: z.string(),
					address: z.string().nullable(),
					geo: z.object({ lat: z.number(), lon: z.number() }).passthrough(),
				})
				.passthrough(),
		),
	})
	.passthrough();

export const cardTelemetryOutputSchema = z
	.object({ ok: z.literal(true) })
	.passthrough();
