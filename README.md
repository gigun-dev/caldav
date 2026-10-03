```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiating `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

開発は `bun install --frozen-lockfile` の後に `make dev`、検証は `make check`。
UI bundleは `scripts/build-ui-bundle.ts` が生成し、内容が同じ場合は再書込みを省く。
watch再発火を調べる際は、起動後のhealth応答と再生成時のmtime・reload収束を分けて確認する。
D1内の座標を含むブラウザ検証手順の公開範囲は未決であり、今回の資料整理では実データを掲載しない。
