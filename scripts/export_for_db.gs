/**
 * scripts/export_for_db.gs — スプレッドシート版(現行GAS.txt)データを D1 移行用 JSON として書き出す(読み取り専用)。
 *
 * 使い方:
 *   1. 移行元スプレッドシート(現行の設定/区分/記録/日次/祝日/取込対応シートが入っている本番ブック)に
 *      紐づく Apps Script プロジェクトに、このファイルをそのまま貼り付ける
 *      (GASエディタ → ファイル → スクリプト → 新規、または コード.gs と同じプロジェクトに追加してもよい。
 *      競合する関数名は無い)。
 *   2. 関数 exportForDb を選択して実行(▶実行)。初回はDrive操作の権限承認が求められる。
 *   3. 実行完了後、Googleドライブのマイドライブ直下に myschedule-export.json が作成される。
 *      実行ログ(表示 → ログ)に処理件数が出る。
 *
 * 注意:
 *   - このスクリプトはシートの読み取りのみ行う。書き込み・変更は一切しない。
 *   - シート構成・列順は現行 GAS.txt (16〜24行のコメント・setupSpreadsheet())のとおり。
 *     設定[キー,値,説明] / 区分[コード,名称,親コード,色,表示順,有効] /
 *     記録[日付,時刻,区分,内訳,メモ] / 日次[日付,有休,日メモ] / 祝日[日付,名称] /
 *     取込対応[タイトル,区分,内訳]
 *   - 日付・時刻の正規化は現行 GAS.txt の fmtDate_/fmtTime_(634〜654行)と同じロジックをここに複製する
 *     (このスクリプトは既存プロジェクトへの一時貼り付け運用のため、GAS.txt の関数には依存しない独立ファイルにする)。
 */

function exportForDb() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var records = exportRecords_(ss);
  var daysInfo = exportDaysInfo_(ss);
  var categories = exportCategories_(ss);
  var config = exportConfig_(ss);
  var importMap = exportImportMap_(ss);
  var holidays = exportHolidays_(ss);

  var payload = {
    records: records,
    daysInfo: daysInfo,
    categories: categories,
    config: config,
    importMap: importMap,
    holidays: holidays
  };

  var json = JSON.stringify(payload);
  var blob = Utilities.newBlob(json, 'application/json', 'myschedule-export.json');
  var file = DriveApp.createFile(blob);

  Logger.log('myschedule-export.json を作成しました: ' + file.getUrl());
  Logger.log('記録(records): ' + records.length + ' 件');
  Logger.log('日次(daysInfo): ' + daysInfo.length + ' 件');
  Logger.log('区分(categories): ' + categories.length + ' 件');
  Logger.log('設定(config): ' + config.length + ' 件');
  Logger.log('取込対応(importMap): ' + importMap.length + ' 件');
  Logger.log('祝日(holidays): ' + holidays.length + ' 件');
}

/* ---- 正規化ヘルパー(GAS.txt の fmtDate_/fmtTime_ と同じロジック。空文字を勝手に変換しない) ---- */

// Date型・各種文字列を 'yyyy-MM-dd' に正規化(読み取りは寛容に。GAS.txt 634〜640行と同一ロジック)
function toDateField_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  return s;
}

// Date型・各種文字列を 'HH:mm' に正規化(GAS.txt 643〜648行と同一ロジック)
function toTimeField_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'HH:mm');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return pad2_(m[1]) + ':' + m[2];
  return s;
}

function pad2_(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

// テキスト列はそのまま文字列として読む(数値化・空文字→0化をさせない)
function toTextField_(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

// 空文字はそのまま''(数値0にしない)。空でなければそのまま返す(json_to_sql側で数値化する)。
function toNumOrEmpty_(v) {
  if (v === '' || v === null || v === undefined) return '';
  return v;
}

function toBool_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/* ---- 記録[日付,時刻,区分,内訳,メモ] → records ---- */
function exportRecords_(ss) {
  var sh = ss.getSheetByName('記録');
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) { // 1行目はヘッダー
    var row = values[i];
    var code = toTextField_(row[2]);
    if (!code) continue; // 区分なし行はスキップ(現行仕様: 記録シートの区分なし行は保存されない)
    out.push({
      date: toDateField_(row[0]),
      time: toTimeField_(row[1]),
      code: code,
      sub: toTextField_(row[3]),
      memo: toTextField_(row[4])
    });
  }
  return out;
}

/* ---- 日次[日付,有休,日メモ] → daysInfo ---- */
function exportDaysInfo_(ss) {
  var sh = ss.getSheetByName('日次');
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var date = toDateField_(row[0]);
    if (!date) continue; // 日付が無い行はスキップ
    out.push({
      date: date,
      paidLeave: toBool_(row[1]),
      memo: toTextField_(row[2])
    });
  }
  return out;
}

/* ---- 区分[コード,名称,親コード,色,表示順,有効] → categories ---- */
function exportCategories_(ss) {
  var sh = ss.getSheetByName('区分');
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // コードが空の行はスキップ
    out.push({
      code: toTextField_(row[0]),
      name: toTextField_(row[1]),
      parent: toTextField_(row[2]),
      color: toTextField_(row[3]),
      sort: toNumOrEmpty_(row[4]),
      active: toBool_(row[5])
    });
  }
  return out;
}

/* ---- 設定[キー,値,説明] → config ---- */
function exportConfig_(ss) {
  var sh = ss.getSheetByName('設定');
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // キーが空の行はスキップ
    // B列(値)はテキスト書式固定の対象外のため、dayStart/dayEnd等がSheetsにより時刻化され
    // getValues()がDate型で返すことがある(旧GAS.txtのfmtTime_にDate分岐があるのが証拠)。
    // Dateならtime化、それ以外は従来どおりテキストとして読む。
    var rawValue = row[1];
    out.push({
      key: toTextField_(row[0]),
      value: (rawValue instanceof Date) ? toTimeField_(rawValue) : toTextField_(rawValue),
      note: toTextField_(row[2])
    });
  }
  return out;
}

/* ---- 取込対応[タイトル,区分,内訳] → importMap ---- */
function exportImportMap_(ss) {
  var sh = ss.getSheetByName('取込対応');
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // タイトルが空の行はスキップ
    out.push({
      title: toTextField_(row[0]),
      code: toTextField_(row[1]),
      sub: toTextField_(row[2])
    });
  }
  return out;
}

/* ---- 祝日[日付,名称] → holidays ---- */
function exportHolidays_(ss) {
  var sh = ss.getSheetByName('祝日');
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var date = toDateField_(row[0]);
    if (!date) continue; // 日付が無い行はスキップ
    out.push({
      date: date,
      name: toTextField_(row[1])
    });
  }
  return out;
}
