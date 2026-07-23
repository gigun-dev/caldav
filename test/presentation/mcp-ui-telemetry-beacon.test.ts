// =============================================================================
// presentation/mcp/ui/telemetry-beacon.ts の純関数/バッファテスト(#52 タスクB Phase 1)
// =============================================================================
// 【何を保証するか(What)】カード側テレメトリの決定論的コアが契約どおりに振る舞うこと:
//   - バッファに積める / size が正しい
//   - デバウンス判定の境界(件数トリガ 10・時間窓 5000ms・pending 0 は常に false)
//   - dedup の count 集約(同一キーは3回まで新規送信・以降は最後のイベントへ count 加算・sum 保存)
//   - instance 全体 30 件で新規生成を停止(集約は上限を消費しない)
//   - drainBatches の 20 件分割
// DOM も時計も持たない純粋コアなので、状態遷移を引数(now)で固定して検証する(fold/safe-area 先例)。
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
	type CardTelemetryEventInput,
	DEBOUNCE_MS,
	FLUSH_ITEM_THRESHOLD,
	INSTANCE_EVENT_CAP,
	MAX_BATCH_EVENTS,
	shouldFlush,
	splitBatches,
	TelemetryBuffer,
} from "../../src/presentation/mcp/ui/telemetry-beacon";

// テスト用ヘルパ: safe-area イベント(dedup を通らない = 純粋にバッファ/上限を見たいとき用)。
function safeArea(dt: number): CardTelemetryEventInput {
	return { dt, kind: "safe-area", top: dt, right: 0, bottom: 0, left: 0, fallbackTopApplied: false, fallbackBottomApplied: false };
}
// テスト用ヘルパ: 同一 dedup キー(name+frame+msgDigest)のエラー。count は既定 1。
function sameError(dt: number, count = 1): CardTelemetryEventInput {
	return { dt, kind: "error", name: "TypeError", frame: "bundle.js:1:1", msgDigest: "deadbeef", count };
}

describe("shouldFlush(デバウンス境界)", () => {
	test("pending 0 は常に false", () => {
		expect(shouldFlush(0, 0, 999999)).toBe(false);
	});
	test("件数トリガ: 9 件は false・10 件は時間に関係なく true", () => {
		expect(shouldFlush(FLUSH_ITEM_THRESHOLD - 1, 0, 0)).toBe(false);
		expect(shouldFlush(FLUSH_ITEM_THRESHOLD, 0, 0)).toBe(true);
	});
	test("時間窓: 経過 4999ms は false・5000ms 以上は true(件数未満でも)", () => {
		// oldest=1000 起点。now=1000+4999 は未満、now=1000+5000 は到達。
		expect(shouldFlush(1, 1000, 1000 + DEBOUNCE_MS - 1)).toBe(false);
		expect(shouldFlush(1, 1000, 1000 + DEBOUNCE_MS)).toBe(true);
	});
});

describe("splitBatches(20 件分割)", () => {
	test("空配列は空バッチ", () => {
		expect(splitBatches([])).toEqual([]);
	});
	test("45 件は [20, 20, 5] に割れる", () => {
		const events = Array.from({ length: 45 }, (_, i) => safeArea(i));
		const batches = splitBatches(events);
		expect(batches.map((b) => b.length)).toEqual([MAX_BATCH_EVENTS, MAX_BATCH_EVENTS, 5]);
		// 分割で要素の取りこぼし/重複が無いこと。
		expect(batches.flat()).toHaveLength(45);
	});
});

describe("TelemetryBuffer: 基本バッファ", () => {
	test("積むと size が増え、drain で空になる", () => {
		const buf = new TelemetryBuffer();
		expect(buf.add(safeArea(0), 0)).toBe("buffered");
		expect(buf.add(safeArea(1), 1)).toBe("buffered");
		expect(buf.size()).toBe(2);
		const batches = buf.drainBatches();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
		expect(buf.size()).toBe(0);
	});

	test("shouldFlushNow: 空→非空で最古時刻を記録し 5000ms 後に true", () => {
		const buf = new TelemetryBuffer();
		buf.add(safeArea(0), 1000);
		expect(buf.shouldFlushNow(1000 + DEBOUNCE_MS - 1)).toBe(false);
		expect(buf.shouldFlushNow(1000 + DEBOUNCE_MS)).toBe(true);
		// drain で起点がリセットされ、pending 0 なので false に戻る。
		buf.drainBatches();
		expect(buf.shouldFlushNow(999999)).toBe(false);
	});
});

describe("TelemetryBuffer: dedup の count 集約", () => {
	test("同一キー 5 連発 → 3 イベント・count は [1,1,3](sum=5 保存)", () => {
		const buf = new TelemetryBuffer();
		expect(buf.add(sameError(0), 0)).toBe("buffered");
		expect(buf.add(sameError(1), 1)).toBe("buffered");
		expect(buf.add(sameError(2), 2)).toBe("buffered");
		// 4 発目・5 発目は上限超過 → 最後(3 発目)のイベントへ集約。
		expect(buf.add(sameError(3), 3)).toBe("aggregated");
		expect(buf.add(sameError(4), 4)).toBe("aggregated");
		expect(buf.size()).toBe(3);
		const events = buf.drainBatches()[0] as Extract<CardTelemetryEventInput, { kind: "error" }>[];
		expect(events.map((e) => e.count)).toEqual([1, 1, 3]);
		// 発生回数の総和が保存される不変条件(count の sum == 発生回数 5)。
		expect(events.reduce((s, e) => s + e.count, 0)).toBe(5);
	});

	test("集約は count 加算(入力 count>1 も足し込む)", () => {
		const buf = new TelemetryBuffer();
		buf.add(sameError(0), 0);
		buf.add(sameError(1), 1);
		buf.add(sameError(2), 2);
		buf.add(sameError(3, 5), 3); // 超過分の count=5 を集約
		const events = buf.drainBatches()[0] as Extract<CardTelemetryEventInput, { kind: "error" }>[];
		expect(events[2].count).toBe(1 + 5);
	});

	test("drain 後は集約先が消えるので同キー超過は dropped-dedup(送信枠 3 は lifetime で維持)", () => {
		const buf = new TelemetryBuffer();
		buf.add(sameError(0), 0);
		buf.add(sameError(1), 1);
		buf.add(sameError(2), 2);
		buf.drainBatches(); // 3 件送信済み・last 参照は落ちる
		// 送信枠(sent=3)は flush をまたいで維持されるので、以降の同キーは新規送信されず集約先も無い。
		expect(buf.add(sameError(3), 3)).toBe("dropped-dedup");
		expect(buf.size()).toBe(0);
	});

	test("異なるキーは独立に 3 件まで送れる", () => {
		const buf = new TelemetryBuffer();
		const a: CardTelemetryEventInput = { dt: 0, kind: "error", name: "A", frame: "x:1:1", msgDigest: "aa", count: 1 };
		const b: CardTelemetryEventInput = { dt: 0, kind: "error", name: "B", frame: "x:1:1", msgDigest: "bb", count: 1 };
		expect(buf.add(a, 0)).toBe("buffered");
		expect(buf.add(b, 0)).toBe("buffered");
		expect(buf.size()).toBe(2);
	});
});

describe("TelemetryBuffer: instance 30 件上限", () => {
	test("31 件目以降は dropped-cap(新規生成のみ上限を消費)", () => {
		const buf = new TelemetryBuffer();
		for (let i = 0; i < INSTANCE_EVENT_CAP; i++) {
			expect(buf.add(safeArea(i), i)).toBe("buffered");
		}
		expect(buf.add(safeArea(99), 99)).toBe("dropped-cap");
	});

	test("上限は flush をまたいで積算される(lifetime)", () => {
		const buf = new TelemetryBuffer();
		for (let i = 0; i < 15; i++) buf.add(safeArea(i), i);
		buf.drainBatches(); // 15 件 flush 済みでも totalCreated は 15 のまま
		for (let i = 0; i < 15; i++) expect(buf.add(safeArea(i), i)).toBe("buffered");
		// ここで累計 30 到達 → 次は dropped-cap。
		expect(buf.add(safeArea(99), 99)).toBe("dropped-cap");
	});

	test("集約(count 加算)は上限を消費しない", () => {
		const buf = new TelemetryBuffer();
		// 29 件の safe-area で埋めた後、同一エラーを 3 発 → 32 発。上限に触れるのは新規生成だけ。
		for (let i = 0; i < INSTANCE_EVENT_CAP - 1; i++) buf.add(safeArea(i), i);
		// 30 件目: エラー1発目(buffered)。
		expect(buf.add(sameError(0), 0)).toBe("buffered");
		// 上限到達後: エラー2発目は新規生成なので dropped-cap。
		expect(buf.add(sameError(1), 1)).toBe("dropped-cap");
	});
});
