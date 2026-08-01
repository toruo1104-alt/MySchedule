# MySchedule プロジェクト

個人用スケジュール管理Webアプリ。フロント=**GitHub Pages**、データ=**スプレッドシート**(GAS JSON API+apiToken)。
Excel「時間記録.xlsx」の置き換え。30分グリッドに区分(UB派遣先/CN自社/BT/FS/ST勉強/FXフレックス等)を塗り、月間集計する。

- **仕様の正**: `docs/仕様書.md`(データ構造の禁止事項・通信/認証・UX統一ルールを変更前に必ず読む)
- **進め方・落とし穴**: `.claude/skills/myschedule-dev/SKILL.md`
- **導入・反映手順**: `README.md`

## ファイルと反映先

| ファイル | 内容 | 反映方法 |
|---|---|---|
| `index.html` / `style.css` / `app.js` | フロント | `git push` → Pages自動反映(https://toruo1104-alt.github.io/MySchedule/) |
| `GAS.txt` | APIサーバー | GAS `コード.gs` へ貼り替え+**新バージョンデプロイ** |
| `appsscript_json.txt` | マニフェスト | GAS `appsscript.json`(変更時のみ) |
| `preview/` | ローカルプレビュー(mock) | 反映不要(http://localhost:8766/preview/index.html) |

リポジトリ: https://github.com/toruo1104-alt/MySchedule (Public — コードのみ。トークン・URL・データは絶対に含めない)

## 状況(2026-08-01時点)

- フェーズ1(月グリッド)+フェーズ2(集計)+フェーズ3(Googleカレンダー取込)実装・公開済み(Pages+API構成)。UI改善(日次UB合計・なぞって消す・Undo・パレット折りたたみ・行高)済み
- フェーズ4a: 週ビュー(月/週トグル。繰り返し予定=背景帯・単発=前面カード・Google Tasks表示、`listWeekData` API)実装済み(2026-08-01)
- **GAS.txt はユーザーが未デプロイの可能性あり**(フェーズ3以降の変更込みで貼り替え+新バージョンデプロイが必要。作業再開時は先にデプロイ済みか確認する)。週ビューのタスク表示はGASのTasks高度なサービス有効化が別途必要(手順はREADME)
- 運用面: スケジュール+タスク管理の方向性検討中(メモリ `schedule-task-management` 参照。第2領域の固定枠カレンダー登録が保留中)
- **次: フェーズ4残り(スマホ閲覧ビュー、Excel過去データ移行)は要望が出たら着手**。現時点で計画書なし・未着手

## リフレッシュ時の再開起点

`docs/仕様書.md` の「11. フェーズ状況」と本ファイルの「状況」を読み、
未完了フェーズと直近の変更(`git log`・`old/` の最新バックアップ)を確認してから着手する。
