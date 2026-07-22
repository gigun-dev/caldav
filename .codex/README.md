# Claude Code / Codex 共有ハーネス

Claude Code 側を正典にし、同じ内容を表現できる Codex surface は symlink で共有する。

| Codex | 正典 | 方式 |
| --- | --- | --- |
| `AGENTS.md` | `CLAUDE.md` | symlink |
| `.agents/skills/*` | `.claude/skills/*` | symlink |
| path別 `AGENTS.md` | `.claude/rules/*.md` | symlink |
| `.codex/hooks/session-start.sh` | `.claude/hooks/session-start.sh` | symlink |

`.codex/hooks.json` と `.codex/config.toml` は設定形式が異なるため、薄いCodex専用adapterとして
管理する。MCPはprojectの `.mcp.json` / Claude pluginと同じ意図で Proxyman と Xcodeを登録する。

## コンテキストの正典

1. `AGENTS.md` / `CLAUDE.md`: 常時必要な不変条件。
2. `docs/next-directions.md`: 最新の現在地と次の作業。最初の `session-head-end` までだけをhook注入。
3. `docs/modeling/`, `docs/rfc/`, `docs/specs/`: 設計と一次資料。該当範囲だけ読む。
4. project skills: deploy、device、MCP検証などトリガー時だけ必要な長い手順。
5. `docs/log.md`: 時系列アーカイブ。通常は全文ロードしない。

Claude project memoryやsession JSONL/tool resultsは機械依存・一時的で秘密を含み得るためsymlinkしない。
恒久化すべき知識だけを上記のinstructions/docs/skillsへ昇格する。

## 保守

- 共通instruction、skill、rules、hook scriptはClaude側の正典だけを編集する。
- Claude settings/plugin/MCPを変えた場合、Codex adapterにも同じ意図を反映する。
- `.claude/settings.local.json` のpermission allowlistと`codex@openai-codex`はCodexへ移植しない。
- repo-local hookはCodexで初回trust確認が入ることがある。新規taskまたは`/hooks`で実発火を確認する。
