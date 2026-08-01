#!/usr/bin/env node
/**
 * scripts/json_to_sql.mjs — export_for_db.gs が出力したJSONをD1投入用 seed.sql に変換する。
 *
 * 使い方:
 *   node scripts/json_to_sql.mjs <export.json>
 *   → scripts/out/seed.sql を生成する(出力先固定。scripts/out/ はgit管理外)。
 *
 * 方針(docs/DB設計.md §3・§8 に準拠。docs/ は本タスクの対象外のため参照のみ):
 *   - records(記録シート=1行1スロット) + daysInfo(日次シート) を date でマージし、
 *     days テーブル(1行1日、slotsはJSON1カラム)へ畳み込む。これがこの変換の核心。
 *   - 同一date+timeの記録行が重複していたら後勝ちとし、警告を標準出力に出す。
 *   - sub/memoが空ならslotsの当該キーから省略する(空文字で残さない)。
 *   - slotsが空 かつ paid_leave=0 かつ memo='' の日は行を作らない(現行仕様=情報のない日は保存しない、を踏襲)。
 *   - config の apiToken キーは必ず除外する(D1には移行せずWorkers Secretへ)。
 *   - days/categories/config/import_map/holidays は `DELETE FROM <table>;` の後にINSERT(本移行は全置換)。
 *   - 文字列は escapeStr() で `'` → `''` に厳密エスケープ(改行・絵文字・日本語を含んでも壊れない)。
 *   - 1 INSERTあたり100行程度ずつ複数VALUESにまとめる(D1のクエリサイズ制限対策)。
 */

import fs from 'node:fs';
import path from 'node:path';

const CHUNK_SIZE = 100;

// ---- 値エスケープ・整形 ----

// 文字列を SQL リテラルへ('を''に厳密エスケープ)。null/undefined は空文字扱い。
function escapeStr(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

// 空文字/null/undefinedは0にする数値列(sort等)。
function sqlNumOrZero(v) {
  if (v === '' || v === null || v === undefined) return '0';
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(n);
}

// 日付文字列を 'yyyy-MM-dd' に正規化(export_for_db.gs の toDateField_ と同じロジックの複製。
// json_to_sql.mjs は本来export_for_db.gsが正規化済みの入力を受け取る前提だが、手編集データ等が
// 混入しても壊れないよう防御的に再正規化する)。Date型は渡ってこない(JSON経由のため文字列のみ)。
function normalizeDateStr(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  return s;
}

// 時刻文字列を 'HH:mm' に正規化(export_for_db.gs の toTimeField_ と同じロジックの複製)
function normalizeTimeStr(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return pad2(m[1]) + ':' + m[2];
  return s;
}

function pad2(n) {
  const s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 複数行を1つ以上のINSERT文にまとめる(100行ごと)。rows=[[val,val,...], ...]
function buildInsert(table, columns, rows) {
  if (rows.length === 0) return '-- ' + table + ': 対象データなし\n';
  const groups = chunk(rows, CHUNK_SIZE);
  const stmts = groups.map(function (g) {
    const valuesSql = g.map(function (r) { return '  (' + r.join(', ') + ')'; }).join(',\n');
    return 'INSERT INTO ' + table + ' (' + columns.join(', ') + ') VALUES\n' + valuesSql + ';';
  });
  return stmts.join('\n') + '\n';
}

// ---- records + daysInfo → days への畳み込み(この変換の核心) ----

// records: [{date,time,code,sub,memo}], daysInfo: [{date,paidLeave,memo}]
// 戻り値: { rows: [{date, slots:{...}, paidLeave, memo}], warnings: [string] }
function mergeDays(records, daysInfo) {
  const warnings = [];
  const byDate = new Map(); // date -> Map(time -> {code,sub,memo})

  (records || []).forEach(function (r) {
    if (!r || !r.date || !r.time || !r.code) return; // 区分なし・日付/時刻欠落はスキップ(現行仕様どおり)
    const date = normalizeDateStr(r.date);
    const time = normalizeTimeStr(r.time);
    if (!byDate.has(date)) byDate.set(date, new Map());
    const timeMap = byDate.get(date);
    if (timeMap.has(time)) {
      const prev = timeMap.get(time);
      warnings.push(
        '重複スロットを後勝ちで上書き: date=' + date + ' time=' + time +
        ' 旧={code:' + prev.code + ',sub:' + JSON.stringify(prev.sub || '') + ',memo:' + JSON.stringify(prev.memo || '') + '}' +
        ' → 新={code:' + r.code + ',sub:' + JSON.stringify(r.sub || '') + ',memo:' + JSON.stringify(r.memo || '') + '}'
      );
    }
    timeMap.set(time, { code: r.code, sub: r.sub || '', memo: r.memo || '' });
  });

  const dayMeta = new Map(); // date -> {paidLeave, memo}
  (daysInfo || []).forEach(function (d) {
    if (!d || !d.date) return;
    const date = normalizeDateStr(d.date);
    dayMeta.set(date, { paidLeave: !!d.paidLeave, memo: d.memo || '' });
  });

  const allDates = new Set([...byDate.keys(), ...dayMeta.keys()]);
  const rows = [];
  allDates.forEach(function (date) {
    const timeMap = byDate.get(date) || new Map();
    const times = Array.from(timeMap.keys()).sort();
    const slots = {};
    times.forEach(function (t) {
      const rec = timeMap.get(t);
      const entry = { code: rec.code };
      if (rec.sub) entry.sub = rec.sub;
      if (rec.memo) entry.memo = rec.memo;
      slots[t] = entry;
    });
    const meta = dayMeta.get(date) || { paidLeave: false, memo: '' };
    const slotsEmpty = Object.keys(slots).length === 0;
    if (slotsEmpty && !meta.paidLeave && !meta.memo) return; // 情報のない日は保存しない(現行仕様どおり)
    rows.push({ date: date, slots: slots, paidLeave: meta.paidLeave, memo: meta.memo });
  });
  rows.sort(function (a, b) { return a.date === b.date ? 0 : (a.date < b.date ? -1 : 1); });
  return { rows: rows, warnings: warnings };
}

// ---- SQL生成(テーブルごと) ----

function buildDaysSql(rows) {
  const columns = ['date', 'slots', 'paid_leave', 'memo'];
  const values = rows.map(function (r) {
    return [
      escapeStr(r.date),
      escapeStr(JSON.stringify(r.slots)),
      r.paidLeave ? '1' : '0',
      escapeStr(r.memo)
    ];
  });
  return '-- days(記録+日次を畳み込み)\n'
    + 'DELETE FROM days;\n'
    + buildInsert('days', columns, values);
}

function buildCategoriesSql(categories) {
  const columns = ['code', 'name', 'parent', 'color', 'sort', 'active'];
  const values = (categories || []).map(function (c) {
    return [
      escapeStr(c.code),
      escapeStr(c.name),
      escapeStr(c.parent),
      escapeStr(c.color),
      sqlNumOrZero(c.sort),
      c.active ? '1' : '0'
    ];
  });
  return '-- categories(区分)\n'
    + 'DELETE FROM categories;\n'
    + buildInsert('categories', columns, values);
}

// dayStart/dayEnd は 'HH:mm' 形式であること。export_for_db.gs 側でDate型化の対策をしても、
// 手編集データ等で化けた値が紛れ込んだまま移行するとD1側で気付けなくなるため、ここで確実に止める。
const HH_MM_RE = /^\d{2}:\d{2}$/;

// config: apiToken キーは必ず除外(D1へ移行せずWorkers Secretへ)。
// dayStart/dayEnd は 'HH:mm' 形式でなければエラーで停止する(①: Date型時刻の文字化け検出)。
function buildConfigSql(config) {
  const filtered = (config || []).filter(function (c) { return c && c.key !== 'apiToken'; });
  (config || []).forEach(function (c) {
    if (!c) return;
    if ((c.key === 'dayStart' || c.key === 'dayEnd') && !HH_MM_RE.test(String(c.value))) {
      throw new Error(
        'config.' + c.key + ' の値が HH:mm 形式ではありません(化けている可能性): ' + JSON.stringify(c.value)
      );
    }
  });
  const excludedCount = (config || []).length - filtered.length;
  const columns = ['key', 'value', 'note'];
  const values = filtered.map(function (c) {
    return [escapeStr(c.key), escapeStr(c.value), escapeStr(c.note)];
  });
  const header = '-- config(設定。apiTokenは除外' + (excludedCount > 0 ? ': ' + excludedCount + ' 件除外しました' : '') + ')\n';
  return header
    + 'DELETE FROM config;\n'
    + buildInsert('config', columns, values);
}

// import_map は初期ルール(0001_init.sqlでINSERT済みの7行)を消さないため、他テーブルと違い
// DELETEしないUPSERT(ON CONFLICT DO UPDATE)にする。エクスポート内容が同名titleを含めば
// 上書きするが、エクスポートに無い初期ルールはそのまま残る(⑥)。
function buildImportMapSql(importMap) {
  if (!importMap || !importMap.length) return '-- import_map: 対象データなし(初期ルールは保持されたまま)\n';
  const columns = ['title', 'code', 'sub'];
  const stmts = chunk(importMap, CHUNK_SIZE).map(function (g) {
    const valuesSql = g.map(function (m) {
      return '  (' + [escapeStr(m.title), escapeStr(m.code), escapeStr(m.sub)].join(', ') + ')';
    }).join(',\n');
    return 'INSERT INTO import_map (' + columns.join(', ') + ') VALUES\n' + valuesSql + '\n'
      + 'ON CONFLICT(title) DO UPDATE SET code = excluded.code, sub = excluded.sub;';
  });
  return '-- import_map(取込対応。DELETEなしのUPSERT。初期ルールは保持したままエクスポート分で上書き)\n'
    + stmts.join('\n') + '\n';
}

function buildHolidaysSql(holidays) {
  const columns = ['date', 'name'];
  const values = (holidays || []).map(function (h) {
    return [escapeStr(h.date), escapeStr(h.name)];
  });
  return '-- holidays(祝日)\n'
    + 'DELETE FROM holidays;\n'
    + buildInsert('holidays', columns, values);
}

// ---- 全体組み立て(run_test.mjs から再利用する中核関数) ----

// data: export_for_db.gs の出力JSON({records,daysInfo,categories,config,importMap,holidays})
// 戻り値: { sql: string, warnings: string[], counts: {days, slotsTotal, categories, config, importMap, holidays} }
function buildSeedSql(data, sourceLabel) {
  const merged = mergeDays(data.records || [], data.daysInfo || []);
  const categories = data.categories || [];
  const config = data.config || [];
  const importMap = data.importMap || [];
  const holidays = data.holidays || [];

  const configFiltered = config.filter(function (c) { return c && c.key !== 'apiToken'; });
  const slotsTotal = merged.rows.reduce(function (sum, r) { return sum + Object.keys(r.slots).length; }, 0);

  const parts = [];
  parts.push('-- seed.sql — export_for_db.gs の出力 (' + (sourceLabel || '') + ') から自動生成 (json_to_sql.mjs)');
  parts.push('-- 生成日時: ' + new Date().toISOString());
  parts.push('');
  parts.push(buildDaysSql(merged.rows));
  parts.push(buildCategoriesSql(categories));
  parts.push(buildConfigSql(config));
  parts.push(buildImportMapSql(importMap));
  parts.push(buildHolidaysSql(holidays));
  // import_map=<n> は「エクスポートからUPSERTで投入した行数」の意味(⑥: DELETEしないため、
  // verify_migration.sql の import_map 総件数はこれと一致しない(0001_init.sqlの初期ルール分だけ多くなりうる)。
  // 突き合わせるときはこの点に注意する。
  parts.push(
    '-- EXPECT days=' + merged.rows.length +
    ' slots_total=' + slotsTotal +
    ' categories=' + categories.length +
    ' config=' + configFiltered.length +
    ' import_map=' + importMap.length +
    ' holidays=' + holidays.length
  );

  return {
    sql: parts.join('\n') + '\n',
    warnings: merged.warnings,
    counts: {
      days: merged.rows.length,
      slotsTotal: slotsTotal,
      categories: categories.length,
      config: configFiltered.length,
      importMap: importMap.length,
      holidays: holidays.length
    }
  };
}

// ---- CLI ----

function main() {
  const [, , inPath] = process.argv;
  if (!inPath) {
    console.error('使い方: node scripts/json_to_sql.mjs <export.json>');
    process.exit(1);
  }

  const raw = fs.readFileSync(inPath, 'utf8');
  const data = JSON.parse(raw);

  let result;
  try {
    result = buildSeedSql(data, inPath);
  } catch (err) {
    console.error('[エラー] ' + (err && err.message ? err.message : err));
    process.exit(1);
  }

  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'seed.sql');
  fs.writeFileSync(outPath, result.sql, 'utf8');

  if (result.warnings.length) {
    console.log('[警告] ' + result.warnings.length + ' 件:');
    result.warnings.forEach(function (w) { console.log('  - ' + w); });
  }

  console.log('config: apiToken キーを除外しました(件数はEXPECTコメント参照)');
  console.log('seed.sql を生成しました: ' + outPath);
  console.log('  days       : ' + result.counts.days + ' 件(slots合計 ' + result.counts.slotsTotal + ')');
  console.log('  categories : ' + result.counts.categories + ' 件');
  console.log('  config     : ' + result.counts.config + ' 件');
  console.log('  import_map : ' + result.counts.importMap + ' 件');
  console.log('  holidays   : ' + result.counts.holidays + ' 件');
}

const isMain = process.argv[1] && (
  process.argv[1] === new URL(import.meta.url).pathname ||
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/json_to_sql.mjs')
);
if (isMain) main();

export { mergeDays, buildSeedSql, escapeStr, buildDaysSql, buildCategoriesSql, buildConfigSql, buildImportMapSql, buildHolidaysSql };
