// =============================================================================
// test/worker/oauth-e2e.test.ts — vitest-pool-workers ハイブリッド導入スライス2。
// OAuth-for-MCP の E2E テスト本体(DCR → authorize 同意 → token 交換 → /mcp 呼び出し)。
// =============================================================================
//
// 【なぜ workerd レーンか(test/ ではなく test/worker/ に置くか)】
// このテストが検証したいのは「@cloudflare/workers-oauth-provider(src/index.ts の
// `export default new OAuthProvider(...)`)が本物の fetch ハンドラとして DCR・authorize・
// token 発行・/mcp へのアクセストークン検証まで一気通貫で動くこと」そのもの。provider の
// 実体は `cloudflare:workers` の値 import を持つため bun test(Node ライク環境)には
// 原理的に載らない(spike.test.ts 冒頭コメント #1 参照)。KV(OAUTH_KV。provider が
// 認可コード・トークン・登録済みクライアントを保存する)・D1(principal/collection
// provisioning)も実物が要るため、実 workerd 上で `exports.default.fetch` を叩く
// このレーンでしか書けない。
//
// 【なぜ1ファイルに全部詰め込むか(state 共有 sequential 前提)】
// vitest-pool-workers は既定でテストファイル単位にストレージ(KV/D1)を隔離する
// (spike.test.ts 冒頭コメント #3 の判定結果)。OAuth 認可コードフローは
// 「DCR で得た client_id → authorize で得た認可コード → token で得た access_token →
// /mcp でその access_token を検証」という4段の状態遷移そのものが検証対象であり、
// これをファイルを分けて書くと provider の KV state(認可コード・トークン)が
// テストファイルごとに別の隔離空間になってしまい、後続ステップが前段の出力を
// 参照できず検証にならない。よってこのファイル内で describe を1つにまとめ、
// it を並べて「前の it が作った値を次の it が使う」sequential な構成にする
// (vitest の it はデフォルトで宣言順に実行される。describe 内でファイルスコープの
// let 変数に橋渡しする)。
//
// 【PKCE ヘルパを自前で書く理由】
// vitest-pool-workers の workerd 環境には Web Crypto(`crypto.subtle`)がそのまま
// 使えるので、依存追加なしで S256 challenge/verifier を作れる。cloudflare:* の
// import は無いので「cloudflare:* を import しないこと」という制約にも抵触しない。
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_DUMMY_SECRETS } from "./test-secrets";

// ExecutionContext はスパイクと同じダミーで足りる(waitUntil/passThroughOnException を
// 実際に使う検証はこのスライスでもしない)。呼び出しのたびに新規に作るのではなく
// 1個を使い回して十分(provider 側がリクエストをまたいで状態を持つのは KV 経由であり、
// ExecutionContext 自体には依存しない)。
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

/** exports.default.fetch を叩く薄い wrapper。spike.test.ts の呼び方をそのまま踏襲する。 */
async function callWorker(request: Request): Promise<Response> {
	return exports.default.fetch(request, env, ctx);
}

// --- PKCE (RFC 7636) ヘルパ ---------------------------------------------------
// code_verifier は RFC 7636 §4.1 の許容文字集合(unreserved: A-Z a-z 0-9 - . _ ~)から
// 43〜128 文字。ここではテスト用に crypto.getRandomValues で 32 byte を生成し
// base64url エンコードした 43 文字を使う(base64url は unreserved 集合の部分集合)。
function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	// btoa は workerd(Web 標準実装)でも使える。+/=  → -_ に変換し padding を落とすのが
	// base64url(RFC 4648 §5)の作法。
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

/** S256: code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) */
async function deriveCodeChallengeS256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64UrlEncode(new Uint8Array(digest));
}

// --- SSE レスポンスパーサ -----------------------------------------------------
// 【なぜ必要になったか(実装時に実挙動を確認して判明)】 @hono/mcp の
// StreamableHTTPTransport は Accept ヘッダに "text/event-stream" が含まれていると
// レスポンスを `text/event-stream`(SSE)で返す(MCP Streamable HTTP transport の仕様上、
// サーバーが SSE と単発 JSON のどちらで返してもクライアントは両対応が必須)。
// 単発リクエスト(initialize や tools/list のような通知を伴わない呼び出し)であっても
// 実際に叩いてみると `content-type: text/event-stream` で `event: message\ndata: {...}\n\n`
// という1イベントだけのストリームが返ってきた(JSON 単発では返らなかった)。
// レスポンスボディを素直に JSON.parse すると失敗するため、"data: " 行を拾って
// JSON.parse する最小限のパーサをここに用意する。SSE の複数イベント・複数行 data・
// コメント行(: で始まる)には対応しない(このテストで来るのは単一イベントのみなので
// オーバーエンジニアリングを避ける)。
async function parseJsonRpcResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();
	if (!contentType.includes("text/event-stream")) return JSON.parse(body);
	const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
	if (!dataLine) throw new Error(`SSE response had no data line: ${body}`);
	return JSON.parse(dataLine.slice("data: ".length));
}

describe("OAuth-for-MCP E2E(スライス2)", () => {
	// DCR → authorize → token の橋渡し用ファイルスコープ state(sequential it 前提。
	// 冒頭コメント参照)。
	let clientId: string;
	let redirectUri: string;
	let codeVerifier: string;
	let codeChallenge: string;
	let authorizationCode: string;
	let returnedState: string;
	let accessToken: string;

	const sentState = "test-state-value-12345";

	beforeAll(async () => {
		codeVerifier = generateCodeVerifier();
		codeChallenge = await deriveCodeChallengeS256(codeVerifier);
		redirectUri = "https://mcp-client.example.com/callback";
	});

	it("(a) DCR: POST /oauth/register で client_id を取得できる", async () => {
		// RFC 7591 の client metadata。redirect_uris は必須(provider が authorize 時に
		// 登録済み redirect_uri との一致を検証するため)。
		// 【token_endpoint_auth_method: "none" を明示する理由(実装時に判明)】これを
		// 省略すると provider は既定で confidential client(client_secret 必須)として
		// 登録し、(c) の token 交換が `401 invalid_client: missing client_secret` で
		// 落ちた。MCP クライアントは PKCE で完結する public client が前提
		// (allowPlainPKCE: false・allowImplicitFlow: false という src/index.ts の設定も
		// 「PKCE で守られた public client」を前提にしている)なので、DCR 時点で
		// public client であることを明示する。
		const response = await callWorker(
			new Request("https://example.com/oauth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					redirect_uris: [redirectUri],
					client_name: "oauth-e2e-test-client",
					token_endpoint_auth_method: "none",
				}),
			}),
		);
		// RFC 7591 §3.2.1 は 201 Created を規定するが、実装によっては 200 を返すこともある
		// ため両方許容する(このテストが確認したいのは「provider が DCR を受理して
		// client_id を発行すること」であって、ステータスコードの厳密な RFC 準拠ではない)。
		expect([200, 201]).toContain(response.status);
		const body = (await response.json()) as { client_id?: string };
		expect(typeof body.client_id).toBe("string");
		clientId = body.client_id as string;
	});

	it("(b) authorize: GET で同意フォームが返り、POST でパスワード同意すると 302 redirect + code + state を得る", async () => {
		const authorizeUrl = new URL("https://example.com/authorize");
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", clientId);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("code_challenge", codeChallenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("scope", "claudedav:read");
		authorizeUrl.searchParams.set("state", sentState);

		// GET: 同意フォーム(HTML)が返る。src/app.ts の authorizeFormHtml が組む
		// <form method="POST" action="/authorize?...">。
		const getResponse = await callWorker(new Request(authorizeUrl.toString()));
		expect(getResponse.status).toBe(200);
		const html = await getResponse.text();
		expect(html).toContain('name="password"');

		// POST: フォームのフィールド名は src/app.ts の実装どおり "password" 1個だけ
		// (username 入力欄は無い。単一ユーザー前提 — src/app.ts コメント参照)。
		// action は "/authorize?<同じクエリ>" なので、POST 先の URL 自体にクエリを付ける。
		const formBody = new URLSearchParams({ password: TEST_DUMMY_SECRETS.CALDAV_PASSWORD });
		const postResponse = await callWorker(
			new Request(authorizeUrl.toString(), {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: formBody.toString(),
				redirect: "manual",
			}),
		);
		// 302: c.redirect(redirectTo, 302)(src/app.ts)。redirect: "manual" で作った
		// Request に対しては fetch がリダイレクトを自動追跡せず、Location ヘッダを
		// そのまま読める(未確定事項ではなく Fetch 標準仕様どおりの挙動)。
		expect(postResponse.status).toBe(302);
		const location = postResponse.headers.get("location");
		expect(location).toBeTruthy();
		const redirectUrl = new URL(location as string, redirectUri);
		const code = redirectUrl.searchParams.get("code");
		const state = redirectUrl.searchParams.get("state");
		expect(code).toBeTruthy();
		authorizationCode = code as string;
		returnedState = state as string;
		// state 往復一致の検証(CSRF/混線防止のための OAuth 標準の作法)。
		expect(returnedState).toBe(sentState);
	});

	it("(c) token: POST /oauth/token で authorization_code を access_token に交換できる", async () => {
		// RFC 6749 §4.1.3: token エンドポイントは application/x-www-form-urlencoded。
		const formBody = new URLSearchParams({
			grant_type: "authorization_code",
			code: authorizationCode,
			code_verifier: codeVerifier,
			client_id: clientId,
			redirect_uri: redirectUri,
		});
		const response = await callWorker(
			new Request("https://example.com/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: formBody.toString(),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { access_token?: string; token_type?: string };
		expect(typeof body.access_token).toBe("string");
		accessToken = body.access_token as string;
	});

	it("(d) /mcp: OAuth access_token で tools/list を呼ぶと5ツールが見える(E-1 create-todo/list-todos 追加)", async () => {
		const response = await callWorker(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					// StreamableHTTPTransport(@hono/mcp)は両方受理できることをクライアントに
					// 要求する(MCP Streamable HTTP transport 仕様)。json のみだと 406 で
					// 拒否されたため両方付ける(実装時に実挙動で確認 — 下の SSE パーサ
					// コメントも参照)。
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			}),
		);
		expect(response.status).toBe(200);
		const rpcResponse = (await parseJsonRpcResponse(response)) as {
			result?: { tools?: Array<{ name: string }> };
		};
		const toolNames = (rpcResponse.result?.tools ?? []).map((tool) => tool.name).sort();
		expect(toolNames).toEqual(["complete-todo", "create-calendar", "create-todo", "create-todos", "delete-calendar", "delete-todo", "get-current-time", "get-freebusy", "list-calendars", "list-events-expanded", "list-todos", "move-todo", "refresh-todos", "update-todo"]);
	});

	it("(e) 静的 Bearer 経路: MCP_TOKEN でも OAuth を経由せず /mcp の tools/list が通る", async () => {
		// resolveExternalTokenForMcp(src/app.ts)の脱出口。provider の内部 KV トークンに
		// 見つからないトークンがこのコールバックへ回ってくる、という配線そのものが
		// スライス2で検証したい「静的 Bearer との共存」の要。
		const response = await callWorker(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${TEST_DUMMY_SECRETS.MCP_TOKEN}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {},
				}),
			}),
		);
		expect(response.status).toBe(200);
		const rpcResponse = (await parseJsonRpcResponse(response)) as {
			result?: { tools?: Array<{ name: string }> };
		};
		const toolNames = (rpcResponse.result?.tools ?? []).map((tool) => tool.name).sort();
		expect(toolNames).toEqual(["complete-todo", "create-calendar", "create-todo", "create-todos", "delete-calendar", "delete-todo", "get-current-time", "get-freebusy", "list-calendars", "list-events-expanded", "list-todos", "move-todo", "refresh-todos", "update-todo"]);
	});

	// --- 失敗系 --------------------------------------------------------------

	it("(f) authorize: 誤ったパスワードでは同意が成立しない(401 + フォーム再表示)", async () => {
		// (b) とは別の認可リクエスト(state を変えて混線を避ける)。src/app.ts の
		// POST /authorize は password 不一致時に 401 + フォーム再表示(error メッセージ付き)を
		// 返す実装(c.html(..., 401))。302 リダイレクトには絶対に落ちないことを確認する
		// (誤った認可コードが発行されてしまうと認可フロー全体の安全性が崩れるため、
		// この失敗系は「302 にならないこと」を明示的に見ておく価値が高い)。
		const authorizeUrl = new URL("https://example.com/authorize");
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", clientId);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("code_challenge", codeChallenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("scope", "claudedav:read");
		authorizeUrl.searchParams.set("state", "wrong-password-state");

		const formBody = new URLSearchParams({ password: "definitely-not-the-password" });
		const response = await callWorker(
			new Request(authorizeUrl.toString(), {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: formBody.toString(),
				redirect: "manual",
			}),
		);
		expect(response.status).toBe(401);
		const html = await response.text();
		expect(html).toContain("パスワードが違います");
	});

	it("(g) /mcp: 無効な Bearer トークンでは 401(RFC 9728 WWW-Authenticate: realm=\"OAuth\")", async () => {
		// provider は「内部 KV トークンとして見つからず、resolveExternalToken でも
		// 一致しない」トークンを invalid_token として 401 で弾く。RFC 9728(Protected
		// Resource Metadata)準拠のクライアントが discovery できるよう WWW-Authenticate
		// ヘッダに realm を含めて返す実装になっている(provider の既定挙動。src/index.ts は
		// この点をカスタマイズしていない)。
		const response = await callWorker(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					Authorization: "Bearer this-token-does-not-exist-anywhere",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
			}),
		);
		expect(response.status).toBe(401);
		const wwwAuthenticate = response.headers.get("www-authenticate");
		expect(wwwAuthenticate).toBeTruthy();
		expect(wwwAuthenticate).toContain('realm="OAuth"');
	});
});
