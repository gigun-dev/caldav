// =============================================================================
// presentation/mcp/ui/freshness.ts — SWR 完全形(2026-07-23)の鮮度判定コア
// =============================================================================
// 【なぜ切り出すか】todos-entry.ts / agenda-entry.ts はブラウザ専用エントリで bun test から
// 直接 import できない(DOM 前提。todos-calendar-filter.ts 冒頭コメントと同じ規律)。判定ロジック
// だけを DOM・module state(lastFetchAt 等)・タイマーから切り離した純関数としてここに置き、
// 両エントリはこれを import して push 経路の分岐に使うだけにする。
//
// 【背景(このモジュールが埋める穴)】
// MCP Apps 仕様はホストが会話履歴を復元してカードを再マウントするときの「tool の再実行」も
// 「新しい可視化の通知」も規定していない(ext-apps 仕様の欠落)。実機では、履歴復元時にホストが
// 過去の(数十分〜数日前の)structuredContent をそのまま ontoolresult として再配送してくることが
// ある。旧実装はカードの唯一の入口 applyStructuredContent が push/fetchLatest/mutation のどの
// 経路でも無条件に markUpdated()(lastFetchAt=Date.now())していたため、「たった今サーバーから
// 届いた」と「数十分前の結果が今さら再配送された」を区別できず、古いスナップショットが
// staleTime(2.5秒)の間 focus refetch まで新鮮を装ってしまっていた(todos-entry.ts:3297-3301 /
// agenda-entry.ts:2008-2010 相当・親レビュー指摘)。
//
// 【なぜ generatedAt を「サーバーが応答生成時に刻んだ時刻」にしたか】
// カード側は自分がいつ push を受け取ったかしか知らず、その push が生成された時刻は知りようが
// 無い(ホストが即時配送したのか、履歴から後日再配送したのかは push 到着時刻だけでは判別不能)。
// server 側(buildTodosViewModel 等)が Date.now() を additive フィールドとして埋め込むことで、
// カードは「(今の時刻) − (生成時刻) = 実際にどれだけ古いデータか」を計算できるようになる。
//
// 【RFC 7234(HTTP キャッシュ)/RFC 5861(stale-while-revalidate)・TanStack Query との類比】
// 「新しい応答は最小限で描き直し、古いデータは即座に見せつつ裏で取り直す」という SWR の骨格そのもの。
// TanStack Query は mount 時に staleTime を過ぎたキャッシュへ自動で background refetch を掛ける
// (画面には即座に古いキャッシュを見せつつ裏で最新化する)。MOUNT_REVALIDATE_MS はその「mount 時
// 鮮度判定の閾値」に相当し、push を「実質的な再マウント/再可視化イベント」とみなして同じ扱いをする。
// =============================================================================

/**
 * push(ontoolresult)経路が運んできた structuredContent を、そのまま「新鮮」と信じてよいかの
 * 閾値(ms)。**Why not: 0 にしない理由** — クロックスキュー(端末とサーバーの時計のずれ、
 * D1/Workers 間の応答組み立て遅延)は普通に数百ms〜数秒発生し得るが、それを「古いデータの
 * 再配送」と誤検知して毎回背景 refetch を掛けると、履歴復元でも何でもない通常の初回描画まで
 * 無駄な IAD 往復と D1 読みを積む(下の「無条件 revalidate をしない理由」参照)。60_000(60秒)は
 * 「クロックスキューは数秒程度なので無害化しつつ、履歴復元のような "実質的に別の訪問" 級の
 * 古さ(分・時間単位)だけを拾う」ラフな閾値。厳密な理論値ではなく調整可能(親レビューで
 * 数値そのものが論点になれば動かしてよい定数として残す)。
 */
export const MOUNT_REVALIDATE_MS = 60_000;

/**
 * push(ontoolresult)経路で届いた structuredContent の generatedAt から、背景 revalidate
 * (maybeRefetch 相当を1回スケジュール)を要求すべきかを判定する純関数。
 *
 * 【引数】
 *   generatedAt: サーバーが応答を生成した時刻(epoch ms)。additive フィールドなので旧サーバー
 *     応答/キャッシュでは undefined になり得る。
 *   now: 判定時点の時刻(epoch ms)。呼び出し側が Date.now() を渡す(テスト容易性のため注入)。
 *
 * 【フォールバック(仕様3: generatedAt 欠落)】
 *   generatedAt が undefined なら「鮮度不明」であり「古い」と決めつけない — false を返し、
 *   呼び出し側は従来どおり push=新鮮(markUpdated)の挙動へ落ちる。**Why not fail-closed
 *   (欠落を「古い」とみなして毎回 revalidate)**: これは ext-apps のホスト固有プロトコルの
 *   欠落を鮮度モデル側の悲観主義で埋め合わせる考え方で、SWR の思想(「まず見せる」を優先し、
 *   検証はあくまで背景で行う)そのものに反する。旧サーバー応答やテストフィクスチャ(generatedAt
 *   を持たない)を「常に古い」と誤判定して余計な refetch を量産するのも実害として大きい。
 *
 * 【負 age の 0 clamp】
 *   generatedAt が now より未来(クロックスキューでサーバー時計がわずかに進んでいる等)のときは
 *   age が負になり得る。マイナス値をそのまま持ち回ると「新しいほど revalidate されやすい」逆転
 *   した比較になりかねないため 0 に丸める(常に「新鮮」側に倒す安全な丸め)。
 *
 * 【なぜ無条件 revalidate をしない設計にしたか(Why not: 全 push で毎回 refetch)】
 * 一見「毎回裏で取り直せば鮮度判定自体が要らず単純」に見えるが、これは誤り。push は
 * 「モデルが今まさに list-todos/create-todo 等を叩いた結果」であることがほとんどで、その
 * push 自体が既に IAD 往復・D1 読みを終えた最新データである。それを無条件に revalidate すると、
 * モデルが取ったばかりのデータを毎回もう一度 D1 まで取りに行く二重取得になり、IAD 往復と D1
 * コストを無駄に倍加させる(2026-07-14 レイテンシ改善で潰した「全件読みの重複」と同種の後退)。
 * generatedAt による鮮度判定は「本当に履歴復元級の古さがあるときだけ」revalidate を発火させる
 * ことで、この無駄を避けつつ穴(冒頭コメント)だけを塞ぐ。
 */
export function shouldRevalidateOnPush(generatedAt: number | undefined, now: number): boolean {
	if (generatedAt === undefined) return false;
	const age = Math.max(0, now - generatedAt);
	return age > MOUNT_REVALIDATE_MS;
}
