# Claude Code / Codex の共有設定

`AGENTS.md` は `CLAUDE.md`、`.agents/skills/*` は `.claude/skills/*`、パス別 `AGENTS.md` は
`.claude/rules/*.md` への symlink で共有する。共有元だけを編集する。

作業開始時は todo スキルで `todo ready` を読み、該当 ADR・modeling・RFC 原文・project skill を確認する。
タスクは `todo.txt` / `done.txt`、設計判断は `docs/adr/`、知識・検証結果は専門 docs に置く。
`docs/next-directions*.md` と `docs/log.md` は凍結した参照記録であり、自動注入・更新しない。

SessionStart の設定とスクリプトは撤去済み。`.codex/config.toml` の Proxyman / Xcode MCP 設定は維持する。
`.githooks/pre-push` は main push 前の `make check` のために維持する。

Claude の個人権限設定・memory・session JSONL は共有しない。
移行対応は [harness-migration.md](../docs/harness-migration.md) を参照する。
