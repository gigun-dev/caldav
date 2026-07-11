// dependency-cruiser 設定 — オニオンアーキテクチャの層境界を CI で機械強制する。
//
// なぜ導入するか(CLAUDE.md「パッケージ構成の方針」より):
//   当面は単一パッケージのままで、ディレクトリ構造 = 将来のパッケージ境界
//   (@caldav/ical / @caldav/core / @caldav/adapter-d1)として設計する。
//   そのため「domain は何も import しない」「presentation → infrastructure 禁止」
//   といった依存方向を人手のレビューではなく CI で強制する。
//
// 依存は常に内側(domain)へ向ける:
//   domain ← application ← { infrastructure, presentation }
//   index.ts はコンポジションルート(全層を配線するので境界の例外)。
//
// 注意: dependency-cruiser は「実際に書かれた import」だけを見る。型 import も追う。
//   現状(2026-07-10 時点)の実態は全ルールを満たしている(手作業 grep で確認済み)。
//   このファイルは「今後壊れたら CI で落とす」ための回帰防止ネット。

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment:
        'domain 層は他のどの層にも依存してはならない(純粋な RFC 5545/4791 モデル)。' +
        '最初に切り出す @caldav/ical は依存ゼロであることが前提。',
      severity: 'error',
      from: { path: '^src/domain' },
      to: {
        path: '^src/(application|infrastructure|presentation)',
      },
    },
    {
      name: 'application-no-outer',
      comment:
        'application(ユースケース)は domain と自身の ports にのみ依存できる。' +
        'infrastructure/presentation という外側の技術詳細に依存してはならない' +
        '(D1・DAV XML・認証は ports 経由で差し替え可能に保つ)。',
      severity: 'error',
      from: { path: '^src/application' },
      to: {
        path: '^src/(infrastructure|presentation)',
      },
    },
    {
      name: 'presentation-not-infrastructure',
      comment:
        'presentation(Hono ルーティング・WebDAV XML)は infrastructure(D1 実装等)に' +
        '直接依存してはならない。配線は index.ts(コンポジションルート)が行う。',
      severity: 'error',
      from: { path: '^src/presentation' },
      to: {
        path: '^src/infrastructure',
      },
    },
    {
      // 2026-07-12 OAuth-for-MCP 第2スライス SHOULD-3: src/app.ts が
      // @cloudflare/workers-oauth-provider の**値**を import してしまうと、provider の
      // 実体(dist/oauth-provider.js)が先頭で引く `cloudflare:workers`(workerd 専用の
      // 仮想モジュール)が src/app.ts 経由で bun test に巻き込まれ、今回の物理分離
      // (app.ts=provider 非依存の Hono アプリ / index.ts=provider を静的 import する
      // コンポジションルート)が無意味になる。この事故を人手のレビュー任せにせず
      // dependency-cruiser で機械的に禁止する。
      //
      // dependencyTypes に 'type-only' があるか確認した(dependency-cruiser 18 系の
      // 型定義 `PartialRuleSet.forbidden[].from/to` に `dependencyTypes` フィールドがあり、
      // 値の一つとして `'type-only'` が定義されている — TypeScript の
      // `import type { ... } from "..."` を静的解析で区別できる)。よって
      // `dependencyTypes: ['type-only']` を `to.pathNot` 相当ではなく明示的に許可対象から
      // 除外する形(`to.dependencyTypesNot: ['type-only']`)でルールを書き、
      // 「値 import だけ禁止・型 import は許可」を機械的に区別する。
      // src/app.ts の冒頭コメントが宣言している「import type すら基本的に不要」という
      // 運用ルールより一段緩い(型 import は許容)が、これは「型 import が紛れ込んでも
      // 実行時に cloudflare:workers を引かない」という技術的事実に基づく——コメント側の
      // 「型 import も避ける」はスタイル上の徹底であって、このルールの強制対象ではない。
      name: 'app-ts-no-oauth-provider-value-import',
      comment:
        'src/app.ts(および presentation/application/domain 配下)から ' +
        '@cloudflare/workers-oauth-provider への値 import を禁止する(import type は許可)。' +
        'provider の実体は cloudflare:workers(workerd 専用仮想モジュール)を静的 import して' +
        'おり、値として import すると bun test 全体がそれを巻き込んで壊れる。provider の' +
        'new は src/index.ts(コンポジションルート)だけが行ってよい。',
      severity: 'error',
      from: { path: '^src/(app\\.ts|presentation|application|domain)' },
      to: {
        path: '^node_modules/@cloudflare/workers-oauth-provider',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-circular',
      comment: '循環依存は設計の崩れの兆候。層をまたがなくても禁止する。',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'どこからも import されず、何も import しないファイル(消し忘れ)を検出する。' +
        'テスト・設定・型定義・エントリポイントは除外。',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '^src/index\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    // src 配下のみを対象にする(scripts / proxy / test は層境界の対象外)。
    doNotFollow: {
      path: 'node_modules',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
