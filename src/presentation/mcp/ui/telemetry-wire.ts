// =============================================================================
// presentation/mcp/ui/telemetry-wire.ts — テレメトリ純粋コアと DOM/SDK の接着(#52 タスクB Phase 1)
// =============================================================================
// 【このファイルの位置づけ】
//   telemetry-beacon.ts(純粋コア)を、実際の window.onerror / callServerTool / DOM 読み取り(mount 起点
//   の経過 ms・activeElement の id)へ繋ぐ薄い接着層。DOM と ext-apps SDK に依存する(bun:test では回さない
//   = 純粋な判定は beacon 側で固定済み)。両 entry(todos/agenda)が import して1 mount に1インスタンス持つ。
//   safe-area.ts と同じ「判断は純粋コア・適用/副作用は wire」という責務分担の延長。
//
//   モジュール変数を持たず class にするのは、todos/agenda が同一バンドルに同居しないため module state 共有の
//   必要が無く、かつ「1 mount = 1 CardTelemetry」を型で明示できるから(safeAreaLogged の bundle 単位 module
//   変数とは事情が違う — あちらは entry ごとに1つで足りるが、こちらは instanceId 等の per-mount 状態を持つ)。
//
// 【PII 境界】beacon.ts 冒頭の境界をこの接着層でも厳守する。特に:
//   - エラーメッセージ本文は fnv1aHex でハッシュ化してから積む(msgDigest。本文は捨てる)。
//   - frame(スタック座標)は URL のクエリ文字列を除去してから積む(?token= 等の混入防止・禁止項目)。
//   - focus-probe が読むのは activeElement.id(コード命名の識別子)だけ。value/textContent は読まない。
// =============================================================================

import { fnv1aHex } from "./content-hash";
import {
	type CardDisplayMode,
	type CardTelemetryBatch,
	type CardType,
	TelemetryBuffer,
} from "./telemetry-beacon";

/** callServerTool だけに依存する最小インタフェース(App 全体を写経しないための seam。ui は末端)。 */
export interface TelemetryApp {
	callServerTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** CardTelemetry の生成引数。displayMode は変化するので getter で受ける(hostDisplayMode を entry が渡す)。 */
export interface CardTelemetryOptions {
	app: TelemetryApp;
	cardType: CardType;
	// uiHash: 焼き込み版ハッシュ(window.__CARD_BUILD_HASH__)。未焼き込み(テスト/旧カード)は undefined。
	uiHash: string | undefined;
	// getDisplayMode: 送信時点の hostDisplayMode(entry の module 変数)を読む。null/未知は "unknown" へ寄せる。
	getDisplayMode: () => string | null;
}

/** mount ごとの 8 文字ランダム ID を採番する。crypto.getRandomValues があれば使い、無ければ Math.random。
 *  【なぜ 8 文字・base36 か】instanceId は「同一 mount のイベント列を束ねる」だけの用途で、暗号強度も
 *  グローバル一意性も不要(サーバーが sessionId/実時刻を別途付ける)。衝突は同一 owner の同時刻 mount 間で
 *  しか問題にならず、8 文字 base36(≒41bit)で十分に低い。既存コード(agenda-entry の draft id 等)が
 *  Math.random().toString(36).slice(2) を使っているのと同じ発想だが、crypto があるならそちらを優先する
 *  (品質基準を上げるだけでコストゼロ・iframe でも crypto.getRandomValues は概ね使える)。 */
export function makeInstanceId(): string {
	const CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
	const g = typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
	if (g !== undefined && typeof g.getRandomValues === "function") {
		const buf = new Uint8Array(8);
		g.getRandomValues(buf);
		let out = "";
		for (let i = 0; i < 8; i++) out += CHARS[buf[i] % CHARS.length];
		return out;
	}
	// フォールバック(crypto 不在): base36 乱数を 8 文字に整える。slice が短すぎる稀な取り出しに備え padEnd。
	return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

/** スタック文字列/source から "URL:line:col" のコード座標を1つ取り出し、クエリ文字列を除去して返す。
 *  取れなければ undefined。**PII 境界: URL のクエリ(?...)は禁止項目なので必ず落とす。** */
function extractFrame(source: string | undefined, lineno?: number, colno?: number): string | undefined {
	// window.onerror は source/lineno/colno を直接くれるので、あればそれを優先(最も確実な最上段座標)。
	if (typeof source === "string" && source.length > 0 && lineno !== undefined) {
		return `${stripQuery(source)}:${lineno}:${colno ?? 0}`;
	}
	return undefined;
}

/** error.stack の最上段から "URL:line:col" を1つ拾う(onerror の source が無い unhandledrejection 用)。 */
function frameFromStack(stack: string | undefined): string | undefined {
	if (typeof stack !== "string") return undefined;
	// 最初に現れる "(...:line:col)" か " ...:line:col" のような座標を素朴に拾う。ブラウザ差(V8/JSC で
	// stack 書式が違う)を厳密に吸収するより、座標らしき最初のマッチを取れれば十分(取れなければ frame 省略)。
	const m = stack.match(/((?:https?|file|blob):[^\s()]+?):(\d+):(\d+)/);
	if (m === null) return undefined;
	return `${stripQuery(m[1])}:${m[2]}:${m[3]}`;
}

/** URL からクエリ(?...)とフラグメント(#...)を除去する(PII 境界: クエリにトークン等が載りうる)。 */
function stripQuery(url: string): string {
	const q = url.indexOf("?");
	const h = url.indexOf("#");
	let end = url.length;
	if (q >= 0) end = Math.min(end, q);
	if (h >= 0) end = Math.min(end, h);
	return url.slice(0, end);
}

/** hostDisplayMode(string|null)を契約の CardDisplayMode へ写す。未知は "unknown"。 */
function toDisplayMode(mode: string | null): CardDisplayMode {
	if (mode === "inline" || mode === "fullscreen") return mode;
	return "unknown";
}

/**
 * 1 mount 分のテレメトリ収集器。install() で global エラーハンドラと flush フックを張り、record* で積む。
 * flush は fire-and-forget(reject は再試行せず破棄 = カードの主機能を絶対に妨げない)。
 */
export class CardTelemetry {
	private readonly opts: CardTelemetryOptions;
	private readonly buffer = new TelemetryBuffer();
	private readonly instanceId = makeInstanceId();
	// mount 起点(dt=経過 ms の基準)。Date.now は実時刻だが、送るのは差分(dt)だけ = PII 安全。
	private readonly mountAtMs = Date.now();
	// デバウンスタイマー(非 error イベントを 5 秒まとめる)。null=未スケジュール。
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	// safe-area の直近適用値(変化検出用)。変化したときだけ積む(毎 hostcontextchanged で積まない)。
	private lastSafeAreaKey: string | null = null;

	constructor(opts: CardTelemetryOptions) {
		this.opts = opts;
	}

	/** mount からの経過 ms(dt)。負にならないよう 0 下限(時計巻き戻りの保険)。 */
	private dt(): number {
		return Math.max(0, Date.now() - this.mountAtMs);
	}

	/**
	 * global エラーハンドラ + ページ退避 flush を張る。connect の前後どちらで呼んでもよいが、error を
	 * 取りこぼさないため **できるだけ早く**(app 生成直後)呼ぶ。
	 * 【pagehide / visibilitychange の実測未確認(統合検証で確認)】sandbox iframe(claude.ai)で
	 * これらが発火するかは一次情報が無い。登録はするが**依存はしない**設計:
	 *   - error は record 時点で即 flush するので pagehide に頼らずサーバーへ届く。
	 *   - safe-area / focus-probe は 5 秒デバウンスで通常経路でも吐かれる。pagehide 発火時の最終 flush は
	 *     「取りこぼしを減らす best-effort」であって、発火しなくても致命的な欠落は起きない。
	 *   実発火の有無は統合検証(本番 iframe + observability)で確認する(docs/log.md へ記録予定)。
	 */
	install(): void {
		if (typeof window === "undefined") return; // 非 DOM 環境(テスト等)では何もしない
		// 未捕捉同期エラー。message/source/lineno/colno/error を SDK ではなくブラウザから直接受ける。
		window.addEventListener("error", (ev: ErrorEvent) => {
			// ev.error があれば name を、無ければ ErrorEvent の message からハッシュを作る(本文は捨てる)。
			const name = ev.error instanceof Error ? ev.error.name : "Error";
			const msg = typeof ev.message === "string" ? ev.message : String(ev.message ?? "");
			const frame =
				extractFrame(ev.filename, ev.lineno, ev.colno) ??
				frameFromStack(ev.error instanceof Error ? ev.error.stack : undefined);
			this.recordError(name, msg, frame);
		});
		// 未捕捉 Promise reject。reason が Error なら name/stack、そうでなければ String(reason) をハッシュ。
		window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
			const reason: unknown = ev.reason;
			const name = reason instanceof Error ? reason.name : "UnhandledRejection";
			const msg = reason instanceof Error ? reason.message : String(reason);
			const frame = frameFromStack(reason instanceof Error ? reason.stack : undefined);
			this.recordError(name, msg, frame);
		});
		// ページ退避での最終 flush(上記コメントのとおり best-effort・依存しない)。
		window.addEventListener("pagehide", () => this.flush());
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flush();
		});
	}

	/** エラーを積んで即 flush(error は溜めずに送る = 落ちる直前でも届く可能性を最大化)。 */
	recordError(name: string, message: string, frame: string | undefined): void {
		// msgDigest: メッセージ本文は絶対に載せず fnv1aHex でハッシュ化(PII 境界)。同一文言の集約キーにもなる。
		const result = this.buffer.add(
			{ dt: this.dt(), kind: "error", name, msgDigest: fnv1aHex(message), frame, count: 1 },
			Date.now(),
		);
		// 集約(count 加算)だけのときは送るバッチが無いこともあるが、flush は空 drain を no-op で握るので常に呼ぶ。
		if (result === "buffered" || result === "aggregated") this.flush();
	}

	/**
	 * safe-area の適用結果を積む(変化したときだけ)。resolveSafeTopPx/Bottom の適用値と fallbackApplied を渡す。
	 * @param fallbackTopApplied top がフォールバック値(申告なし fullscreen)で埋まったか。
	 * @param fallbackBottomApplied 同 bottom。
   */
	recordSafeArea(
		top: number,
		right: number,
		bottom: number,
		left: number,
		fallbackTopApplied: boolean,
		fallbackBottomApplied: boolean,
	): void {
		// 変化検出キー: 全数値 + fallback フラグ。同じ値の再適用(hostcontextchanged 連発)では積まない。
		const key = `${top}|${right}|${bottom}|${left}|${fallbackTopApplied ? 1 : 0}|${fallbackBottomApplied ? 1 : 0}`;
		if (key === this.lastSafeAreaKey) return;
		this.lastSafeAreaKey = key;
		this.buffer.add(
			{ dt: this.dt(), kind: "safe-area", top, right, bottom, left, fallbackTopApplied, fallbackBottomApplied },
			Date.now(),
		);
		this.scheduleFlush();
	}

	/**
	 * ⊕→fullscreen 昇格フローの focus-probe を積む。activeElementId は id 属性名のみ(PII 安全)。
	 * @param phase "before"=requestDisplayMode 直前 / "after"=昇格解決後(entry が 600ms 後に呼ぶ)。
	 * @param activeElementId document.activeElement?.id(空文字は undefined 化して渡すこと)。
	 * @param sheetInputConnected sheetTitleInput?.isConnected。
	 * @param sheetInputActive sheetTitleInput === document.activeElement。
	 */
	recordFocusProbe(
		phase: "before" | "after",
		activeElementId: string | undefined,
		sheetInputConnected: boolean,
		sheetInputActive: boolean,
	): void {
		this.buffer.add(
			{ dt: this.dt(), kind: "focus-probe", phase, activeElementId, sheetInputConnected, sheetInputActive },
			Date.now(),
		);
		this.scheduleFlush();
	}

	/** デバウンスタイマーを（未スケジュールなら）張る。件数トリガに達していれば即 flush。 */
	private scheduleFlush(): void {
		if (this.buffer.shouldFlushNow(Date.now())) {
			this.flush();
			return;
		}
		if (this.debounceTimer !== null) return; // 既にタイマーがあるので二重に張らない
		if (typeof setTimeout === "undefined") return;
		// DEBOUNCE_MS は beacon の shouldFlushNow が時間窓の真の基準。タイマーは「起こす」だけの役なので
		// 発火時に改めて drain する(shouldFlushNow を待たず drain する = タイマーが鳴った=時間経過とみなす)。
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.flush();
		}, 5000);
	}

	/**
	 * 未送信を drain して callServerTool へ送る(fire-and-forget)。空なら何もしない。
	 * reject は再試行せず捨てる(テレメトリの失敗でカードの主機能や UX を絶対に妨げない)。
	 */
	flush(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		const batches = this.buffer.drainBatches();
		if (batches.length === 0) return;
		const displayMode = toDisplayMode(this.opts.getDisplayMode());
		for (const events of batches) {
			const batch: CardTelemetryBatch = {
				cardType: this.opts.cardType,
				// uiHash 未焼き込み(旧カード/テスト)は空文字で送る — 契約は string なので undefined を渡さない。
				// サーバー側はこの値で版分類するだけなので空でも受理可能(additive)。
				uiHash: this.opts.uiHash ?? "",
				instanceId: this.instanceId,
				displayMode,
				events,
			};
			// callServerTool の arguments は Record<string, unknown> 期待。CardTelemetryBatch は閉じた型なので
			// 境界の1点で cast する(server.ts の toTodosToolResponse 等と同じ「閉じた型 vs SDK index signature」対処)。
			void this.opts.app
				.callServerTool({ name: "report-card-telemetry", arguments: batch as unknown as Record<string, unknown> })
				.catch(() => {
					// 破棄(再試行しない)。テレメトリは best-effort。失敗理由もサーバーに送れないので握るだけ。
				});
		}
	}
}
