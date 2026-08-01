-- 0001_init.sql — D1 スキーマ初期化(フェーズ5: スプレッドシート → D1移行)
-- シート構成(GAS.txt 16-25行)の1:1移植。列の挿入・順序変更は禁止(docs/仕様書.md 5章)。
-- config は「設定」シート相当(apiTokenはenv.API_TOKENへ移行したためD1には含まない)。
-- days は「記録」シート(1行=1スロット)+「日次」シート(有休・日メモ)を1日1行に統合し、
-- スロットは slots 列にJSON({"HH:mm":{code,sub,memo}})で保持する。

CREATE TABLE days (
  date       TEXT PRIMARY KEY,
  slots      TEXT NOT NULL DEFAULT '{}',
  paid_leave INTEGER NOT NULL DEFAULT 0,
  memo       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL,
  name   TEXT NOT NULL DEFAULT '',
  parent TEXT NOT NULL DEFAULT '',
  color  TEXT NOT NULL DEFAULT '',
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  note  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE import_map (
  title TEXT PRIMARY KEY,
  code  TEXT NOT NULL DEFAULT '',
  sub   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '祝日'
);

-- config 初期値(GAS.txt 112-129行 ensureConfigDefaults_ を写経。apiTokenはenv側のため除く)
INSERT INTO config (key, value, note) VALUES
  ('dayStart', '06:00', 'グリッド表示の開始時刻'),
  ('dayEnd', '22:00', 'グリッド表示の終了時刻(この時刻の枠は含まない)'),
  ('ownHoursPerDay', '8', '自社の要求業務時間(h/勤務日)'),
  ('clientHoursPerDay', '7.5', '派遣先の要求業務時間(h/勤務日)'),
  ('clientWorkCode', 'UB', '派遣先業務の区分コード(集計の実績比較に使用)'),
  ('manMonthRatio', '0.6', '契約人月(要求時間 = 勤務日数 × h/日 × この係数)'),
  ('calendarIds', '', 'カレンダー取込の対象カレンダーID(カンマ区切り)');

-- 区分マスタ初期値(GAS.txt 131-160行 ensureDefaultCategories_ を写経)
INSERT INTO categories (code, name, parent, color, sort, active) VALUES
  ('UB', '派遣先業務', '', '#aecde8', 10, 1),
  ('CN', '自社業務', '', '#d9c2e9', 20, 1),
  ('BT', 'ベテル奉仕', '', '#c9e3b4', 30, 1),
  ('FS', '奉仕', '', '#ffe699', 40, 1),
  ('MT', '集会', '', '#f4b8b8', 50, 1),
  ('CW', '会衆の仕事', '', '#f8cbad', 60, 1),
  ('ST', '勉強', '', '#b4dcd8', 70, 1),
  ('ST1', '個人研究', 'ST', '', 71, 1),
  ('ST2', '割当準備', 'ST', '', 72, 1),
  ('ST3', '聖書通読', 'ST', '', 73, 1),
  ('ST4', '集会予習', 'ST', '', 74, 1),
  ('FX', 'フレックス', '', '#e2e8cf', 80, 1),
  ('FX1', '料理', 'FX', '', 81, 1),
  ('FX2', '掃除', 'FX', '', 82, 1),
  ('FX3', '洗濯', 'FX', '', 83, 1),
  ('FX4', 'エクササイズ', 'FX', '', 84, 1),
  ('FX5', 'レク', 'FX', '', 85, 1),
  ('mv', '移動', '', '#d9d9d9', 90, 1);

-- 取込対応(import_map)の初期ルール(GAS.txt 165-182行 ensureImportMapDefaults_ を写経)
INSERT INTO import_map (title, code, sub) VALUES
  ('築地出社', 'UB', ''),
  ('テレワーク', 'UB', ''),
  ('UB', 'UB', ''),
  ('神谷町', 'UB', ''),
  ('奉仕', 'FS', ''),
  ('BRV', 'BT', ''),
  ('集会', 'MT', '');
