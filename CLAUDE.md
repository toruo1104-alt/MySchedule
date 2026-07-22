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

## 状況(2026-07-22時点)

- フェーズ1(月グリッド)+フェーズ2(集計)実装・公開済み(Pages+API構成)。UI改善(日次UB合計・なぞって消す・Undo・パレット折りたたみ・行高)済み
- **次: フェーズ3(Googleカレンダー取込)の実装**。詳細計画は `docs/フェーズ3計画.md` — ユーザー確認済みの仕様判断を含むため、**計画に書かれた範囲を計画どおりに実装する**(要件の再ヒアリング不要)。実装完了時は計画書末尾の「引き渡し」を必ず実施

## リフレッシュ時の再開起点

`docs/仕様書.md` の「11. フェーズ状況」と本ファイルの「状況」を読み、
未完了フェーズと直近の変更(`git log`・`old/` の最新バックアップ)を確認してから着手する。
