# MySchedule プロジェクト

個人用スケジュール管理Webアプリ。フロント・API=**Cloudflare Workers**(Static Assets + D1)、Googleカレンダー・Tasksの読み取りは**専用GASプロキシ**経由。
Excel「時間記録.xlsx」の置き換え。30分グリッドに区分(UB派遣先/CN自社/BT/FS/ST勉強/FXフレックス等)を塗り、月間集計する。

- **仕様の正**: `docs/仕様書.md`(データ構造の禁止事項・通信/認証・UX統一ルールを変更前に必ず読む)
- **バックエンド設計・構築手順**: `docs/DB設計.md` / `docs/構築手順書.md`
- **進め方・落とし穴**: `.claude/skills/myschedule-dev/SKILL.md`
- **導入・反映手順**: `README.md`

## ファイルと反映先

| ファイル | 内容 | 反映方法 |
|---|---|---|
| `web/` | フロント(index.html/style.css/app.js) | `git push` → `cd worker && npx wrangler deploy` |
| `worker/` | API(src/index.js、src/actions/*、migrations/*.sql) | 同上(スキーマ変更は`npx wrangler d1 migrations apply DB --remote`も) |
| `gas/calendar_proxy.gs` | Googleカレンダー・Tasksのステートレスな窓口 | プロキシ専用GASプロジェクトへ貼り替え+**新バージョンデプロイ** |
| `preview/` | ローカルプレビュー(mock) | 反映不要(http://localhost:8766/preview/index.html) |

リポジトリ: https://github.com/toruo1104-alt/MySchedule (Public — コードのみ。トークン・URL・データは絶対に含めない)

## 状況(2026-08-02時点)

- フェーズ1〜3(月グリッド・集計・Googleカレンダー取込)+フェーズ4a〜4e(週ビュー・モバイル実用化・連続日送り・PWA対応・安定化)実装済み
- **フェーズ5カットオーバー完了(2026-08-02)**: 旧構成(GitHub Pages+GAS JSON API+スプレッドシート)を退役し、Cloudflare Workers+D1へ完全移行。**現行本番 = https://myschedule.toruo1104.workers.dev**。反映は `cd worker && npx wrangler deploy`。カレンダー/Tasks連携はプロキシ専用GASプロジェクト経由(設計=`docs/DB設計.md`、手順=`docs/構築手順書.md`)
- 旧スプレッドシートはアーカイブ(読み取り専用で温存)。旧GASプロジェクト(スプレッドシート版API)は退役(GitHub Pagesの無効化・旧GASのアーカイブはユーザー操作。復旧が必要な場合は`old/`とgit履歴から可能)
- 運用面: 第2領域の固定枠はGoogleカレンダー登録済み・運用開始(メモリ `schedule-task-management` 参照)
- **次: Excel過去データ移行(時間記録.xlsx)は要望が出たら着手**。現時点で計画書なし・未着手

## リフレッシュ時の再開起点

`docs/仕様書.md` の「11. フェーズ状況」と本ファイルの「状況」を読み、
未完了フェーズと直近の変更(`git log`・`old/` の最新バックアップ)を確認してから着手する。
