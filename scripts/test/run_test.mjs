#!/usr/bin/env node
/**
 * scripts/test/run_test.mjs — json_to_sql.mjs の変換ロジックを fixture.json で検証するテスト。
 *
 * 使い方: node scripts/test/run_test.mjs
 *
 * sk-visit-map-DBver/scripts/smoke.mjs の「record()で結果を集計してPASS/FAIL表を出す」パターンを踏襲。
 * 検証項目(発注の受け入れ条件①):
 *   - シングルクォートが '' に正しくエスケープされているか
 *   - configにapiTokenのINSERTが含まれていないか
 *   - 重複スロット(同一date+time)の警告が出ているか
 *   - 末尾の -- EXPECT ... コメントが出力され、件数が正しいか
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeedSql } from '../json_to_sql.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;
const rows = [];

function record(name, ok, detail) {
  rows.push({ name, result: ok ? 'PASS' : 'FAIL', detail: detail || '' });
  if (ok) passCount++; else failCount++;
}

function printTable() {
  const nameW = Math.max(...rows.map((r) => r.name.length), 4);
  const resW = 6;
  const line = (a, b, c) => `${a.padEnd(nameW)} | ${b.padEnd(resW)} | ${c}`;
  console.log(line('項目', '結果', '詳細'));
  console.log('-'.repeat(nameW + resW + 10));
  rows.forEach((r) => console.log(line(r.name, r.result, r.detail.slice(0, 200))));
  console.log('-'.repeat(nameW + resW + 10));
  console.log(`PASS=${passCount} / FAIL=${failCount} / TOTAL=${rows.length}`);
}

function main() {
  const fixturePath = path.join(__dirname, 'fixture.json');
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const data = JSON.parse(raw);

  const result = buildSeedSql(data, fixturePath);
  const sql = result.sql;

  // ---- ① シングルクォートのエスケープ ----
  // 08-01 09:00 の "シングルクォート'あり" 行は同時刻の重複記録により後勝ちで上書きされ消えるため
  // (③で別途検証)、エスケープ確認は上書きされずに残る行(有休メモ・取込対応のタイトル)で行う。
  {
    const okAll = [
      sql.includes("上書き後メモ"),
      sql.includes("有休のみの日''クォート含む"),
      sql.includes("奉仕''テスト")
    ].every(Boolean);
    // 生の(エスケープされていない)単一クォートが残っていないことも確認
    const noRawQuote = !sql.includes("有休のみの日'クォート含む") && !sql.includes("奉仕'テスト");
    record('① シングルクォートのエスケープ', okAll && noRawQuote,
      `okAll=${okAll} noRawQuote=${noRawQuote}`);
  }

  // ---- ② configにapiTokenが含まれない ----
  {
    const noApiTokenKey = !sql.includes("'apiToken'");
    const noDummyTokenValue = !sql.includes('dummy-token-should-be-excluded-1234');
    record('② config: apiToken除外', noApiTokenKey && noDummyTokenValue,
      `noApiTokenKey=${noApiTokenKey} noDummyTokenValue=${noDummyTokenValue}`);
  }

  // ---- ③ 重複スロットの警告 ----
  {
    const hasDupWarning = result.warnings.some((w) =>
      w.includes('date=2026-08-01') && w.includes('time=09:00'));
    record('③ 重複スロット警告(1桁時刻の正規化込み)', hasDupWarning,
      JSON.stringify(result.warnings));
  }

  // ---- ④ 末尾のEXPECTコメント・件数 ----
  {
    const m = sql.match(/-- EXPECT days=(\d+) slots_total=(\d+) categories=(\d+) config=(\d+) import_map=(\d+) holidays=(\d+)/);
    const hasExpectLine = !!m;
    let countsOk = false;
    let detail = 'EXPECTコメントが見つかりません';
    if (m) {
      const expected = { days: 5, slotsTotal: 4, categories: 3, config: 3, importMap: 2, holidays: 2 };
      const actual = {
        days: Number(m[1]), slotsTotal: Number(m[2]), categories: Number(m[3]),
        config: Number(m[4]), importMap: Number(m[5]), holidays: Number(m[6])
      };
      countsOk = JSON.stringify(expected) === JSON.stringify(actual);
      detail = `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`;
    }
    record('④ EXPECTコメントの件数一致', hasExpectLine && countsOk, detail);
  }

  // ---- 参考: 日付/時刻正規化(スラッシュ日付・1桁時刻がキーとして正しく畳み込まれているか) ----
  {
    // 2026/8/2 13:30 → date=2026-08-02, time=13:30 で FS のスロットが1件だけ生成されているはず
    // (同日の区分なし行はスキップされているため slots は1件のみ)。
    const ok = sql.includes('2026-08-02') && sql.includes('13:30');
    record('参考: スラッシュ日付/1桁時刻の正規化', ok, 'sqlに2026-08-02/13:30が含まれるか');
  }

  // ---- 参考: 区分なし行のスキップ ----
  {
    const ok = !sql.includes('区分なしなのでスキップされる');
    record('参考: 区分なし記録行のスキップ', ok, 'スキップ対象メモがSQLに含まれないこと');
  }

  // ---- 参考: 情報のない日は行を作らない(2026-08-11) ----
  {
    // daysテーブルのINSERT行として日付単体 '2026-08-11' が出現しないこと(holidaysには同日が別途あるため
    // holidaysのINSERTには出現してよい。daysの行としてのみ確認する)
    const daysSection = sql.split('-- categories')[0];
    const ok = !daysSection.includes("'2026-08-11'");
    record('参考: 情報のない日はdays行を作らない', ok, 'days部分に2026-08-11が含まれないこと');
  }

  // ---- ①(ネガティブケース) 設定シートのDate型時刻の文字化けを検出してエラー停止する ----
  {
    const badFixturePath = path.join(__dirname, 'fixture_bad_config.json');
    const badData = JSON.parse(fs.readFileSync(badFixturePath, 'utf8'));
    let threw = false;
    let message = '';
    try {
      buildSeedSql(badData, badFixturePath);
    } catch (err) {
      threw = true;
      message = err && err.message ? err.message : String(err);
    }
    const messageOk = /dayStart/.test(message) && /HH:mm/.test(message);
    record('① dayStartのDate文字化けをエラー停止で検出', threw && messageOk, message);
  }

  printTable();

  const outPath = path.join(__dirname, '..', 'out', 'run_test_out.sql');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, sql, 'utf8');
  console.log('生成SQL(参考): ' + outPath);

  process.exitCode = failCount > 0 ? 1 : 0;
}

main();
