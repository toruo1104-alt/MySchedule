---
name: myschedule-dev
description: >
  MySchedule(個人スケジュール管理アプリ: Cloudflare Workers+D1+GASプロキシ)の開発時に使う。
  web/(index.html/style.css/app.js) / worker/ / gas/calendar_proxy.gs / docs/仕様書.md を触るとき、
  グリッド・週ビュー・区分・塗り操作・集計・保存・祝日・API認証・カレンダー取込に関わる作業のとき、
  明示的に頼まれていなくても積極的に発動すること。
---

# MySchedule 開発ガイド

## 全体像

Cloudflare Workers(Static Assetsでフロント配信+/api) + D1(SQLite、データ) + GASプロキシ(カレンダー/Tasks窓口)の
個人用スケジュール管理アプリ。本番 = https://myschedule.toruo1104.workers.dev
**仕様(what)は [docs/仕様書.md](../../../docs/仕様書.md) が正** — コードを変える前に該当節を読む。
特に「3. システム構成・通信(トークン認証)」「5. データモデル(変更禁止事項)」「7. UX統一ルール」は遵守対象。
バックエンド設計の詳細は docs/DB設計.md、構築・運用は docs/構築手順書.md。

## 黄金ルール

- **Publicリポジトリ**: トークン・URL・個人データをコード/コミットに絶対に含めない
  (API設定はlocalStorage、API_TOKEN/GAS_URL/GAS_TOKENはWorkers Secret、.dev.vars/scripts/out/はgitignore)
- スキーマ変更は `worker/migrations/` に新規SQL追加のみ(適用済みマイグレーションの書き換え禁止)
- 日付は `yyyy-MM-dd`、時刻は `HH:mm` の文字列。Date型を状態に持ち込まない。SQLは必ず prepare().bind()
- API契約({token,fn,args}/{ok,data}|{ok,error}封筒・fn名・出力キー)は互換を守る
- 新しい操作を追加するときは保存の型(楽観更新→dirty→デバウンス→ステータス表示)と
  Escルール(最前面から1つずつ閉じる)に乗せてから完成とする
- YAGNI: 頼まれていない抽象化・リファクタはしない
- 機能・パラメータ・色・APIを変えたら仕様書を同じターンで更新する

## 進め方

1. **変更前バックアップ**: 対象ファイルを `old/yyyyMMdd_説明/` にコピーしてから編集(git併用でも従来流儀を維持)
2. **編集**: 大きめの変更は `careful-large-file-edits` の手順(grep→直前Read→一意なold_stringで最小差分)
3. **検証(ローカル)**:
   - フロントのみ: プレビューサーバー(`myschedule-preview`、ポート8766)で
     `http://localhost:8766/preview/index.html`。mock.js が `__MYSCHEDULE_MOCK__` でAPIを偽装する
   - worker込み: `cd worker && npx wrangler dev --local`(+初回 `d1 migrations apply DB --local`)→
     `node worker/test/smoke.mjs` を**連続2回**(冪等性ごと確認。ローカルD1はsmokeが初期状態にリセットする)
4. **引き渡し**(`change-handoff-checklist` 準拠):
   - web/・worker/ の変更 → `git add/commit/push` + `cd worker && npx wrangler deploy`(即時反映)
   - `gas/calendar_proxy.gs` 変更 → ユーザーにプロキシ専用GASプロジェクトへの貼り替え+
     「デプロイを管理→**新バージョン**」を案内(URLは変わらない)
   - シークレット変更(`wrangler secret put`)は反映に数十秒の伝播遅延がある(即時の認証エラーで慌てない)

## 既知の落とし穴

- **ブラウザペインの screenshot / computer クリックが効かない環境がある**
  → 症状: screenshot がタイムアウト、left_click が成功表示でもページに届かない
  → 対処: 検証は `javascript_tool` でDOM検査+イベントディスパッチ(`.click()`、MouseEvent)で行い、
    見た目の最終確認はユーザーに依頼する
- **表示/非表示の検証は DOM プロパティだけでは不十分(実バグの反省)**
  → `hidden` 属性は author CSS の `display: flex` に負ける。`el.hidden === true` でも表示され続けうる。
    style.css の `[hidden] { display: none !important; }` を消さないこと。
  → 検証は `getComputedStyle(el).display` と `document.elementFromPoint()`(最前面要素の確認)で行う
- **PowerShell 5.1 の Get-Content は既定でANSI読み** → UTF-8ファイルが文字化けする。
  ファイル生成・変換はWrite/Editツールで行う(シェルのリダイレクトで作らない)
- **GASの新バージョンデプロイ忘れ** → コードを貼り替えても本番に反映されない
- **CORS**: GASへのfetchは `Content-Type: text/plain` を維持すること(preflightに応答できない)。
  ヘッダーを増やしたり application/json にすると通信が失敗する
- **モックのリセット** → `localStorage.removeItem('myschedule-mock')`。API設定のリセット →
  `localStorage.removeItem('myschedule-api')`
- **祝日が出ない** → 本番: 祝日シートの該当年の行を削除して再アクセス(再取得される)。
  モック: mock.js の HOLIDAYS_2026 は2026年分のみハードコード
- **時間帯外の記録**: dayStart前/dayEnd後のスロットは表示されないが集計には含まれる(仕様)
- **入れ子スクロールと `position: sticky`**: `overflow: auto`/`hidden` の内側スクロールコンテナ配下の要素の
  sticky は、外側コンテナのスクロールには追従しない(sticky は最近接スクロールコンテナ基準)。
  週ビューの曜日ヘッダーはこのため JS 疑似 sticky(`translateY` 同期。`syncWeekDayHeaderSticky`)を使っている
- **入れ子スクロールと `scroll-snap`**: `scroll-snap-align`/`scroll-snap-stop` を持つスナップ領域も
  最近接スクロールコンテナに捕捉される。週ビューのスナップマーカー(`.wk-snap-marker`)は必ず
  `.wk-days-scroller` の外(`.wk-hwrap` 直下)に置くこと(内側に置くと縦スナップが黙って無効化される。実際に起きた)
