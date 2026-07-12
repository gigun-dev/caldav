// =============================================================================
// structure/edit — Component ツリーの汎用編集プリミティブ(E-1 スライス①新設)
// =============================================================================
//
// 【なぜここに置くか】
// これまで domain/ical/structure/ は parse/serialize が生成する Component ツリーを
// 「読むだけ」だった(semantics/ 層のレンズも読み取り専用)。E-1(MCP からの VTODO 作成)で
// 初めて「Component ツリーを組み立てる」必要が生まれたが、組み立てのプリミティブは
// VEVENT/VTODO/VJOURNAL のどれにも依存しない汎用操作(プロパティの置換・追加・削除、
// サブコンポーネントの追加)なので、意味論を持たない structure/ 層に置く。
// VTODO 固有の組み立て(due の DTSTART/DUE 連動など)は semantics/vtodo-write.ts に隔離し、
// このファイルには一切 VTODO 語彙を持ち込まない(層の責務分離)。
//
// 【設計原則: すべて純関数・readonly のまま新オブジェクトを返す】
// types.ts の Component/Property/Parameter は readonly なプレーンオブジェクト。
// この方針を編集関数側でも維持し、「元の Component は変更されない」ことを型と実装の
// 両方で保証する(呼び出し側が誤って古い参照を使い回しても事故らない = 予測可能性)。
//
// 【エスケープ/折り畳みはこの層の責務ではない】
// upsertProperty 等が受け取る value は「生テキスト(すでにエスケープ済み)」。
// TEXT のエスケープ(encodeText)は values/text-value.ts、75 オクテット折り畳みは
// serialize/serializer.ts が担う。ここで二重にエスケープ/折り畳みを行うと、
// serializer が値をそのまま出力する前提(types.ts の設計決定)を壊してロスレス往復が
// 崩れるため、呼び出し側(vtodo-write.ts)がエスケープ済みの値を渡す契約にする。
// =============================================================================

import type { Component, Parameter, Property } from "./types";

/**
 * 同名プロパティのうち**最初の1つ**を新しい値/パラメータで置換する。
 * 同名プロパティが無ければ末尾に追加する。
 *
 * 【出現順を保持する理由】
 * RFC 5545 §3.6 はプロパティの順序に意味を持たせないが、既存プロパティを「置換」する際に
 * 配列の先頭へ動かしたり末尾に動かしたりすると、無関係な diff が生まれて PUT 応答の
 * ETag(オクテット等価に近いほど検証しやすい)が余計に変わる。置換は「同じ位置で書き換える」
 * ことで、既存データの改変を最小限にする(types.ts の「並べ替えは意味を壊す」方針を踏襲)。
 *
 * 【複数出現する同名プロパティは対象外】
 * RELATED-TO や ATTENDEE のような複数出現しうるプロパティを想定していない
 * (E-1 スライス①が組み立てる VTODO は SUMMARY/DUE/PRIORITY 等、単一出現のプロパティのみ)。
 * 複数出現プロパティの編集が要るときは別関数(insertProperty 等)を追加する。
 */
export function upsertProperty(
	component: Component,
	name: string,
	value: string,
	parameters: readonly Parameter[] = [],
): Component {
	const newProp: Property = { name, parameters, value };
	const index = component.properties.findIndex((p) => p.name === name);
	if (index === -1) {
		return { ...component, properties: [...component.properties, newProp] };
	}
	const properties = component.properties.slice();
	properties[index] = newProp;
	return { ...component, properties };
}

/**
 * 同名プロパティを**全件**取り除く。
 * (upsertProperty と対称な最小限のプリミティブ。E-1 スライス①では未使用だが、
 * 将来の部分更新 UC — 例えば due を消す PATCH 相当 — で使う想定のため先に用意しておく。)
 */
export function removeProperty(component: Component, name: string): Component {
	return { ...component, properties: component.properties.filter((p) => p.name !== name) };
}

/**
 * サブコンポーネントを末尾に追加する(VALARM を VTODO/VEVENT に足す等)。
 * 常に追加のみ(同名の既存サブコンポーネントを探して置換する用途は想定しない —
 * サブコンポーネントは複数存在が普通なので「置換」の意味が一意に決まらないため)。
 */
export function appendSubComponent(component: Component, child: Component): Component {
	return { ...component, components: [...component.components, child] };
}
