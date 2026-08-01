# DB版 設計書（実装の正）— MySchedule フェーズ5

本書は GitHub Pages + GAS(JSON API) + スプレッドシート版 MySchedule を Cloudflare Workers + D1 に置き換える設計の**正**。
実装エージェントは本書と、移植元 `GAS.txt`・`docs/仕様書.md`(現行API契約は6章)を参照して作業する。
画面・操作・色・パラメータ等の機能仕様は `docs/仕様書.md` がそのまま正であり、本書はバックエンド置換と契約の互換性、およびハイブリッド構成(Googleカレンダー連携の扱い)のみを扱う。

## 0. 決定事項サマリ

| # | 論点 | 決定 |
|---|---|---|
| 1 | 移行先 | **Cloudflare Workers(素のESM・ビルドなし) + D1(SQLite) + Workers Static Assets**。フロントはWorkers Static Assets配信でAPIと同一オリジン(GitHub Pages廃止はカットオーバー時) |
| 2 | 構成方式 | **ハイブリッド**。Googleカレンダー・Google Tasks・祝日の読み取りだけは既存GASプロジェクトを「ステートレスな窓口」(`gas/calendar_proxy.gs`)として残す(CalendarApp/Tasksの無償利用のため。ユーザー確認済み 2026-08-01)。それ以外のデータ(記録・区分・設定等)はD1へ完全移行 |
| 3 | データの持ち方 | 記録(1行=1スロット)+日次を **`days` 1テーブル(1行=1日)に統合**し、スロットはJSONで1カラムに畳む(sk-visit-map `TargetList` 履歴データ方式を採用。ユーザーの明示要望) |
| 4 | API契約 | 現行 `GAS.txt` と**完全互換**。`{token, fn, args}` 形式のPOST `/api`、`{ok,data}`/`{ok,error}` 封筒、fn名・出力キーは一字一句同じ→フロント改修ほぼゼロ |
| 5 | 認証 | `apiToken` はD1に置かず **Workers Secret(`API_TOKEN`)**。GASプロキシへは `GAS_URL`/`GAS_TOKEN` シークレットでWorkerがサーバー側から呼ぶ(フロントにGAS URLを見せない) |
| 6 | 反映 | `npx wrangler deploy` のみ(Claude実行可能)。ユーザーの手作業は初回セットアップとGASプロキシの1回だけの貼り替え |

## 1. 構成

```
[ブラウザ]
  web/ (index.html + style.css + app.js)  ← Worker Static Assets が配信(同一オリジン)
     │ POST /api  {token, fn, args}
     ▼
[Cloudflare Worker]  worker/src/
  index.js   … ルーティング・token照合・fn振り分け・{ok,data}/{ok,error}封筒
  actions/   … 各fnの実装(月データ・保存・区分・カレンダー取込・週データ)
     │ prepare().bind()（常にバインド変数。文字列連結SQL禁止）
     ▼                              │ サーバー側fetch(GAS_URL, {token:GAS_TOKEN,...})
[D1 (SQLite)]                       ▼
  days / categories / config /  [既存GASプロジェクト] gas/calendar_proxy.gs（ステートレス窓口）
  import_map / holidays           ├─ CalendarApp → Googleカレンダー(本人+祝日)
                                   └─ Tasks(高度なサービス) → Google Tasks
```

- 同一オリジン化によりCORSプリフライトは発生しない。
- Worker名・D1データベース名は構築手順書の初回構築で確定する(例: `myschedule-db`。バインディング名 `DB`)。
- タイムゾーン: **Workersの実行時刻はUTC**。日付判定・祝日キャッシュ年の判定等は現行同様 **Asia/Tokyo で明示フォーマット/解釈**すること(GASはJST実行だったため、ここを怠ると日付境界がズレる)。

## 2. API契約(互換保証)

- エンドポイント: `POST /api`。ボディは `{token, fn, args}` のJSON(Content-Type `text/plain`)。
- 成功: `{ok:true, data:<fn固有>}`。失敗: `{ok:false, error:<文言>}`。フロントの `handleServerError` は無改修で動く。
- fn一覧・引数・戻り値の**正は現行 `docs/仕様書.md` 6章と現行 `GAS.txt`** であり、移植時は**写経**する。独自判断でfn名・出力キーを増減・変更しない。日本語キーを含め1文字でも変えるとフロント全体が壊れる。
- 差分は下記のみ(§3参照)。それ以外の入出力は現行と完全一致。

### fn別の差分注記

| fn | 契約 | 内部差分 |
|---|---|---|
| `getMonthData` | 契約同一(`{ym, config, categories, records[], days[], holidays{}}`) | `days` テーブルから月内の日を読み、`slots` JSONを `records[]` 形式(1行=1スロット)に展開して返す。`paid_leave`/`memo` は `days[]` へ展開 |
| `saveMonthRecords` | 契約同一(`[ym, [{date,time,code,sub,memo}]]` → `{ok, savedYm}`) | 月内の各日について `slots` を丸ごと置換(記録側の**月ブロック置換**方針を踏襲)。`paid_leave`/`memo` は保持。書込は `DB.batch()` で原子化。**対象月外の日付を持つレコードは、その日の行へスロット単位でマージ**(既存の他スロット・有休・メモは保持)。カレンダー取込で前月末開始の予定を取り込むケースの旧GAS挙動(月外行も保存)を踏襲 |
| `saveMonthDays` | 契約同一(`[ym, [{date,paidLeave,memo}]]` → `{ok, savedYm}`) | `paid_leave`/`memo` を置換。`slots` は保持。`saveMonthRecords` の逆。同じく対象月外の日付はその日の行へマージする |
| `saveCategories` | 契約同一 | `categories` テーブルを全置換(既存仕様どおり) |
| `saveImportMap` | 契約同一 | `import_map` テーブルへタイトルでupsert |
| `listCalendarEvents` | 契約同一(`{events[], importMap}`) | Workerが `gas/calendar_proxy.gs` の `listCalendarEvents` へサーバー側fetch転送(calendarIdsはD1 `config` から渡す)。`importMap` はD1 `import_map` から付加 |
| `listWeekData` | 契約同一(`{events[], tasks[], tasksAvailable, holidays{}}`) | `events`/`tasks`/`tasksAvailable` はGASプロキシ `listWeekData` へ転送。`holidays` はD1 `holidays` から返す(年単位でGASプロキシ `getHolidays` から補充キャッシュ) |

- 空の日(スロットなし・有休0・メモ空)の行は保存されない現行仕様を踏襲: `days` 行の `slots='{}'` かつ `paid_leave=0` かつ `memo=''` になった場合はDELETE。
- 祝日取得失敗は現行同様サーバー側で握りつぶし、キャッシュで動作継続。

## 3. D1スキーマ

`worker/migrations/0001_init.sql` に以下を定義する(コメント含め一字一句このとおり):

```sql
CREATE TABLE days (
  date       TEXT PRIMARY KEY,            -- 'yyyy-MM-dd'
  slots      TEXT NOT NULL DEFAULT '{}',  -- {"HH:mm":{"code":"UB","sub":"…","memo":"…"},…} sub/memoは空なら省略
  paid_leave INTEGER NOT NULL DEFAULT 0,  -- 旧「日次」の有休
  memo       TEXT NOT NULL DEFAULT ''     -- 旧「日次」の日メモ
);
CREATE TABLE categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,  -- 表示順はsort。行の同一性は問わない(全置換運用)
  code   TEXT NOT NULL,
  name   TEXT NOT NULL DEFAULT '',
  parent TEXT NOT NULL DEFAULT '',           -- 空=大区分
  color  TEXT NOT NULL DEFAULT '',
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE config (
  key   TEXT PRIMARY KEY,   -- dayStart/dayEnd/ownHoursPerDay/clientHoursPerDay/clientWorkCode/manMonthRatio/calendarIds
  value TEXT NOT NULL DEFAULT '',
  note  TEXT NOT NULL DEFAULT ''
);  -- apiTokenは移行しない(Workers Secretへ)
CREATE TABLE import_map (
  title TEXT PRIMARY KEY,
  code  TEXT NOT NULL DEFAULT '',
  sub   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '祝日'
);
```

- **INSERT/UPDATEは必ず `prepare().bind()`**。文字列連結でのSQL組み立ては禁止。
- 現行「設定」シートの `apiToken` はD1へ移行しない(Workers Secret `API_TOKEN` へ置換)。それ以外の設定キー(`dayStart`/`dayEnd`/`ownHoursPerDay`/`clientHoursPerDay`/`clientWorkCode`/`manMonthRatio`/`calendarIds`)は `config` テーブルへ移行する。
- `import_map` はマイグレーションで初期7ルールを投入する。seed投入はDELETEせず、titleでUPSERTする。

## 4. Worker API実装方針

- `worker/src/index.js`: リクエストボディの `token` をWorkers Secret `API_TOKEN` と照合。不一致は現行同様 `{ok:false, error:...}` で全拒否。一致後 `fn` で `worker/src/actions/*` へ振り分ける。
- fn一覧(全7件。現行 `docs/仕様書.md` 6章の表と1:1対応):
  - `getMonthData` / `saveMonthRecords` / `saveMonthDays` / `saveCategories` / `saveImportMap`: 契約同一。内部でdaysへの畳み込み⇔展開を行う。`saveMonthRecords` は月内の各日のslotsを丸ごと置換しpaid_leave/memoは保持、`saveMonthDays` はその逆。slotsが空かつ有休0かつメモ空になった行はDELETE(空の日は保存されない現行仕様の踏襲)。書き込みは `DB.batch()` で原子化する。
  - `listCalendarEvents(ym)`: WorkerがGASプロキシへ転送(calendarIdsはD1 configから渡す)+importMapはD1から付加。
  - `listWeekData(from,to)`: events/tasks/tasksAvailableはGASプロキシ、holidaysはD1(年単位でGASプロキシ `getHolidays` から補充キャッシュ)。
- 祝日取得失敗は握りつぶしキャッシュ継続(現行仕様踏襲)。

## 5. GASプロキシ(`gas/calendar_proxy.gs`)

既存GASプロジェクトを、スプレッドシート非依存の**ステートレスな窓口**として残す。`{token, fn, args}` 形式で受け、tokenはScript Propertiesの `PROXY_TOKEN` と照合する。データの読み書きは一切行わず、CalendarApp/Tasksの結果をそのまま返すだけ。

| fn | args | 戻り値 | 備考 |
|---|---|---|---|
| `listCalendarEvents` | `(ym, calendarIds)` | `{events[]}` | 現行の月取込と同じイベント形(recurringなし)。importMapはWorker側(D1)が付加するためここでは返さない |
| `listWeekData` | `(from, to, calendarIds)` | `{events[], tasks[], tasksAvailable}` | holidaysはここでは返さない(Worker側がD1から返す) |
| `getHolidays` | `(year)` | `{holidays:[{date,name}]}` | 説明欄「祝日」フィルタは現行 `GAS.txt` の仕様を踏襲 |

## 6. 認証・シークレットの持ち方

- `apiToken` は D1 に置かず **Workers Secret `API_TOKEN`** として保持し、フロントからのリクエストの `token` と照合する。
- GASプロキシの呼び出しに使う `GAS_URL`・`GAS_TOKEN` も Workers Secret として保持し、Workerがサーバー側からGASプロキシへfetchする(フロントにGAS URLを一切見せない)。
- GASプロキシ側の認証トークンは Script Properties の `PROXY_TOKEN`(GASプロジェクト側の管理)。

## 7. 新フォルダ構成

```
web/       … フロント3ファイル(index.html / style.css / app.js)
worker/    … src/index.js, src/actions/*, migrations/0001_init.sql, wrangler.jsonc, package.json
gas/       … calendar_proxy.gs, appsscript.json
scripts/   … export_for_db.gs, json_to_sql.mjs, verify_migration.sql, test/
preview/   … ローカルプレビュー(モック)。変更最小、温存
docs/      … 本書・構築手順書等
old/       … 変更前バックアップ(既存の従来流儀を継続)
```

`GAS.txt`・`appsscript_json.txt` はカットオーバーコミットで削除予定(それまで本番参照用に残す)。

## 8. データ移行設計(3段+検証)

1. `scripts/export_for_db.gs` を既存GASプロジェクトに一時貼り付け → `exportForDb` を実行 → マイドライブにJSON出力(読み取り専用・シート無変更)。
2. `scripts/json_to_sql.mjs` で `days` への畳み込み+SQL生成(出力は `scripts/out/` 配下。**`.gitignore` 対象**)。
3. `npx wrangler d1 execute --remote --file=...` でD1へ投入。
4. `scripts/verify_migration.sql` で件数突合(days行数・`json_each` によるスロット総数一致・`json_valid` 全件・各テーブル件数)+サンプル目視。

> ⚠ **データファイル(exportしたJSON・生成したseed.sql等)はPublicリポに絶対にコミットしない。** MyScheduleリポジトリは無料GitHub Pagesの条件でPublicであり、個人のスケジュールデータが漏洩する。`scripts/out/` は `.gitignore` 対象とし、手元でのみ扱うこと。

## 9. フロント差分

現行 `docs/仕様書.md` 4章のファイル構成のうち、フロント3ファイル(`index.html`/`style.css`/`app.js`)はカットオーバー前後で以下のみ変更する想定(実装は別担当が担当。ここでは契約上の前提のみ記す):

- API接続先(URL)の切替はカットオーバー時にフロントの設定モーダル(⚙)経由でWorkerのURLへ変更(既存のlocalStorage設定の仕組みをそのまま使う)。
- `token`/`fn`/`args` の送受信形式・エラーハンドリング(`handleServerError`)は無改修。

