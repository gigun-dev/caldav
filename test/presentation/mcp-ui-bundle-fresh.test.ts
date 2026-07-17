// =============================================================================
// mcp-ui-bundle-fresh — MCP Apps カード JS バンドルの「再生成し忘れ」検出テスト
// =============================================================================
// 2026-07-17: todos-entry.ts を修正したのに `bun run build:ui` で *-bundle.ts を
// 再生成せずコミット→デプロイしてしまい、本番に修正が反映されない事故が起きた。
// bundle は自動生成ファイル(手で編集しない)なので、「entry から今生成される内容」と
// 「実際にコミットされている out ファイルの内容」がバイト一致することを機械的に保証する。
//
// なぜ scripts/build-ui-bundle.ts の generateBundleFileContent を import して使うか:
// このテストが独自に Bun.build を呼んで同じロジックのつもりで比較すると、スクリプト側と
// テスト側でロジックが乖離したときに気づけず(テストのバグで green になる)、
// 「本番配信物と一致しているか」を保証したいという本来の目的を達成できない。
// 生成ロジックの正は scripts/build-ui-bundle.ts の1箇所に置き、スクリプト本体(main)と
// このテストの両方がそこから呼ぶことで、両者が常に同じ入力→出力対応になることを保証する。
//
// minify の非決定性について: Bun の minifier はバージョン間で出力バイト列が変わりうる
// (変数名の割り当てや空白の詰め方等)。ローカルの bun バージョンと CI の bun バージョンが
// ずれると、entry を正しく再生成していても出力バイトが一致せずこのテストが誤って落ちる
// (false positive)。これを防ぐため .github/workflows/ci.yml の setup-bun は
// package.json 記載の bun バージョンではなく明示的に固定バージョンを指定している
// (詳細はそちらのコメント参照)。ローカルも同じバージョンを使うこと。
// =============================================================================

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { generateBundleFileContent, TARGETS } from "../../scripts/build-ui-bundle";

describe("MCP Apps カードバンドルの鮮度", () => {
	for (const target of TARGETS) {
		it(`${target.out.split("/ui/")[1]} は entry から再生成した内容と一致する(stale なら bun run build:ui を実行してコミットし忘れていないか確認すること)`, async () => {
			const expected = await generateBundleFileContent(target);
			const actual = await readFile(target.out, "utf-8");

			expect(actual).toBe(expected);
		});
	}
});
