// =============================================================================
// scripts/build-ui-bundle.ts — MCP App(ui://)のブラウザ SDK 自己完結バンドル生成
// =============================================================================
// 【何をするスクリプトか】
//   src/presentation/mcp/ui/*-entry.ts(@modelcontextprotocol/ext-apps の App を import する
//   ブラウザ向け TS)を bun build でブラウザ向け単一 JS にバンドルし、結果を
//   src/presentation/mcp/ui/*-bundle.ts(自動生成ファイル)へ書き出す。*-app.ts はその
//   生成物をテンプレートリテラル補間で HTML の <script type="module"> にインライン埋め込みする。
//
//   骨格は姉妹プロジェクト tdr-concierge の同名スクリプトを流用している(同じ Hono/CF Workers
//   構成・同じ MCP Apps 方式)。caldav では現状エントリが todos-entry.ts の1件だけなので
//   TARGETS も1件だが、将来 events 用等を足せるよう配列のまま残す(tdr 同様)。
//
// 【なぜ format: "esm" か("iife" ではないか)】
//   エントリは app.connect() を top-level await している(接続完了を待ってから診断表示を
//   進める設計)。top-level await は ESM でのみ許可される構文で、IIFE では bun build 自体が
//   ビルドエラーになる。埋め込み先の HTML も `<script type="module">` として読み込むので ESM の
//   ままで問題ない。
//
// 【なぜ minify するか】
//   HTML はサーバー(Workers)にソースとして同梱される。バンドル後の ext-apps + zod は
//   非圧縮で数百KBあるため、minify した方が git diff の可読性・Workers script size 両面で軽い。
//
// 【node組み込み依存が混入した場合の方針】
//   ext-apps・zod はブラウザ向けに書かれており node:* import は混入しない想定。混入したら
//   握りつぶさず(ブラウザ非互換の依存が紛れ込んだ兆候なので)エラーで停止する。
// =============================================================================

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** バンドル対象の一覧。エントリ追加時はここに1行足すだけでよい
 *  (tsconfig 側は src/presentation/mcp/ui/*-entry.ts glob で追従するので編集不要 —
 *   tsconfig.json / tsconfig.ui.json のコメント参照)。 */
const UI_DIR = join(import.meta.dirname, "..", "src", "presentation", "mcp", "ui");
const TARGETS = [
	{
		entry: join(UI_DIR, "todos-entry.ts"),
		out: join(UI_DIR, "todos-bundle.ts"),
		constName: "TODOS_BUNDLE_JS",
	},
] as const;

async function buildOne(target: (typeof TARGETS)[number]): Promise<void> {
	const result = await Bun.build({
		entrypoints: [target.entry],
		target: "browser",
		format: "esm",
		minify: true,
	});

	if (!result.success) {
		console.error(`✗ ${target.entry} のバンドル生成に失敗しました:`);
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}

	if (result.outputs.length !== 1) {
		// entry を1つしか渡していないので出力も1個のはず。code splitting 等で増えたら
		// 「単一 <script> に埋め込む」という *-app.ts 側の前提が崩れるため停止する。
		console.error(`✗ ${target.entry}: 想定外の出力数 ${result.outputs.length}(1個を期待)。code splitting 設定を疑うこと。`);
		process.exit(1);
	}

	const js = await result.outputs[0]!.text();

	// node組み込みモジュールの混入チェック(上記コメント参照)。混入していたら原因調査のため停止する。
	if (js.includes("node:")) {
		console.error(`✗ ${target.entry}: バンドルに node: import が混入しています。ブラウザ非互換の依存が紛れ込んだ可能性。`);
		console.error('   grep \'"node:\' で該当箇所を確認すること。');
		process.exit(1);
	}

	// </script> の早期終了防止(HTML の <script> 本体に丸ごとインラインするため)。
	// バンドル後の JS が文字列リテラル等で "</script>" を含むことは通常ないはずだが、
	// 依存ライブラリのエラーメッセージ等に紛れ込む可能性はゼロではないため機械的に処置する。
	const escaped = js.replace(/<\/script>/gi, "<\\/script>");

	const outBase = target.out.split("/ui/")[1] ?? target.out;
	const entryRel = target.entry.split("/src/")[1] ? `src/${target.entry.split("/src/")[1]}` : target.entry;
	const banner = `// =============================================================================
// presentation/mcp/ui/${outBase} — 【自動生成ファイル・手で編集しない】
// =============================================================================
// scripts/build-ui-bundle.ts が ${entryRel} を bun build でブラウザ向け
// 単一 ESM にバンドルした結果。@modelcontextprotocol/ext-apps の App クラスと zod を
// 完全にインライン化しており、実行時の外部 import は一切無い(esm.sh 依存を排除した経緯は
// ${entryRel} 冒頭コメント参照)。
//
// 再生成コマンド: \`bun run build:ui\`(= \`bun run scripts/build-ui-bundle.ts\`)。
// ${entryRel} を変更したら必ず再生成し、この生成物ごとコミットすること
// (tsc の型チェック・bun test・deploy 前の Makefile が最新のこのファイルを前提にしている)。
//
// JSON.stringify で文字列リテラル化している理由(テンプレートリテラルを使わない理由):
// バンドル後の JS にはバックスラッシュ・バッククォート・改行が任意に含まれ得るため、
// 普通のテンプレートリテラルや String.raw で埋め込むと構文事故を起こしやすい。
// JSON.stringify した文字列リテラルなら、どんな内容が来ても常に妥当な TS の文字列リテラルと
// してエスケープされるため、この種の事故が構造的に起きない。
// =============================================================================

`;

	const body = `export const ${target.constName} = ${JSON.stringify(escaped)} as const;\n`;

	await mkdir(dirname(target.out), { recursive: true });
	await writeFile(target.out, banner + body, "utf-8");

	console.log(`✓ ${target.out} を生成しました(minified ${js.length} bytes / escaped ${escaped.length} bytes)`);
}

async function main() {
	for (const target of TARGETS) {
		await buildOne(target);
	}
}

await main();
