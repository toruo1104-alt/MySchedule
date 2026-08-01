// ローカルスモークテスト。`wrangler dev --local` 起動中に `node worker/test/smoke.mjs` で実行する。
// 発注文「ローカル検証」の8項目を一つずつ確認し、PASS/FAILを表示して非0終了で失敗を知らせる。
// 再実行可能性: テスト冒頭で days/categories/import_map をマイグレーション初期状態へ
// リセットしてから実行する(項目7のsaveCategories/saveImportMapがローカルD1に残留し、
// 次回実行時の項目3=初期値検証を壊すため)。configはどのテストも書き換えないため対象外。
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.API_TOKEN || 'dummy-local-token';
const WORKER_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');

// worker/migrations/0001_init.sql の区分マスタ初期値と同一(写経元を変えたらここも合わせる)
const INITIAL_CATEGORIES = [
  { code: 'UB', name: '派遣先業務', parent: '', color: '#aecde8', sort: 10, active: 1 },
  { code: 'CN', name: '自社業務', parent: '', color: '#d9c2e9', sort: 20, active: 1 },
  { code: 'BT', name: 'ベテル奉仕', parent: '', color: '#c9e3b4', sort: 30, active: 1 },
  { code: 'FS', name: '奉仕', parent: '', color: '#ffe699', sort: 40, active: 1 },
  { code: 'MT', name: '集会', parent: '', color: '#f4b8b8', sort: 50, active: 1 },
  { code: 'CW', name: '会衆の仕事', parent: '', color: '#f8cbad', sort: 60, active: 1 },
  { code: 'ST', name: '勉強', parent: '', color: '#b4dcd8', sort: 70, active: 1 },
  { code: 'ST1', name: '個人研究', parent: 'ST', color: '', sort: 71, active: 1 },
  { code: 'ST2', name: '割当準備', parent: 'ST', color: '', sort: 72, active: 1 },
  { code: 'ST3', name: '聖書通読', parent: 'ST', color: '', sort: 73, active: 1 },
  { code: 'ST4', name: '集会予習', parent: 'ST', color: '', sort: 74, active: 1 },
  { code: 'FX', name: 'フレックス', parent: '', color: '#e2e8cf', sort: 80, active: 1 },
  { code: 'FX1', name: '料理', parent: 'FX', color: '', sort: 81, active: 1 },
  { code: 'FX2', name: '掃除', parent: 'FX', color: '', sort: 82, active: 1 },
  { code: 'FX3', name: '洗濯', parent: 'FX', color: '', sort: 83, active: 1 },
  { code: 'FX4', name: 'エクササイズ', parent: 'FX', color: '', sort: 84, active: 1 },
  { code: 'FX5', name: 'レク', parent: 'FX', color: '', sort: 85, active: 1 },
  { code: 'mv', name: '移動', parent: '', color: '#d9d9d9', sort: 90, active: 1 }
];

let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    failed++;
    console.log('FAIL: ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
  }
}

async function call(fn, args, token) {
  const res = await fetch(BASE + '/api', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ token: token !== undefined ? token : TOKEN, fn, args: args || [] })
  });
  const json = await res.json();
  return { status: res.status, json };
}

function d1Exec(sql) {
  return execSync(
    `npx wrangler d1 execute DB --local --json --command "${sql.replace(/"/g, '\\"')}"`,
    { cwd: WORKER_DIR, encoding: 'utf8' }
  );
}

function d1Query(sql) {
  const out = d1Exec(sql);
  const parsed = JSON.parse(out);
  return parsed[0] && parsed[0].results ? parsed[0].results : [];
}

// テスト冒頭で days/categories/import_map をマイグレーション直後の状態へ戻す(冪等な再実行のため)
function resetDbToInitialState() {
  d1Exec('DELETE FROM days');
  d1Exec('DELETE FROM categories');
  d1Exec('DELETE FROM import_map');
  const values = INITIAL_CATEGORIES
    .map((c) => `('${c.code}','${c.name}','${c.parent}','${c.color}',${c.sort},${c.active})`)
    .join(',');
  d1Exec(`INSERT INTO categories (code, name, parent, color, sort, active) VALUES ${values}`);
}

async function main() {
  resetDbToInitialState();

  // 1. GET /api → app名JSON
  {
    const res = await fetch(BASE + '/api');
    const json = await res.json();
    ok('1. GET /api -> app名', json && json.ok === true && json.app === 'MySchedule API', json);
  }

  // 1b. GET /api/ (末尾スラッシュ) → app名JSON
  {
    const res = await fetch(BASE + '/api/');
    const json = await res.json();
    ok('1b. GET /api/ -> app名', json && json.ok === true && json.app === 'MySchedule API', json);
  }

  // 2. token不一致 → {ok:false}
  {
    const { json } = await call('getMonthData', ['2026-01'], 'wrong-token');
    ok('2. token不一致 -> ok:false', json && json.ok === false, json);
  }

  // 3. getMonthData(空月) → config/categories初期値
  {
    const { json } = await call('getMonthData', ['2026-01']);
    const cfgOk = json.ok && json.data.config.dayStart === '06:00' && json.data.config.dayEnd === '22:00'
      && json.data.config.ownHoursPerDay === 8 && json.data.config.clientHoursPerDay === 7.5
      && json.data.config.clientWorkCode === 'UB' && json.data.config.manMonthRatio === 0.6;
    const cats = json.ok ? json.data.categories : [];
    const codes = cats.map((c) => c.code).join(',');
    const expectCodes = 'UB,CN,BT,FS,MT,CW,ST,ST1,ST2,ST3,ST4,FX,FX1,FX2,FX3,FX4,FX5,mv';
    ok('3. getMonthData 初期値(config)', cfgOk, json.data && json.data.config);
    ok('3. getMonthData 初期値(categories)', codes === expectCodes, codes);
  }

  // 4. saveMonthRecords → getMonthData ラウンドトリップ一致(10スロット以上、端・絵文字・引用符・改行・sub付き/なし)
  const records = [
    { date: '2026-01-05', time: '06:00', code: 'UB' },
    { date: '2026-01-05', time: '06:30', code: 'UB', sub: '' },
    { date: '2026-01-05', time: '07:00', code: 'ST', sub: 'ST1' },
    { date: '2026-01-05', time: '21:30', code: 'FX', sub: 'FX2', memo: '掃除🧹' },
    { date: '2026-01-06', time: '09:00', code: 'MT', memo: '集会\n夕方"引用符"' },
    { date: '2026-01-06', time: '09:30', code: 'CN' },
    { date: '2026-01-07', time: '10:00', code: 'BT' },
    { date: '2026-01-07', time: '10:30', code: 'FS', memo: '奉仕😊"改行\nテスト"' },
    { date: '2026-01-10', time: '13:00', code: 'mv' },
    { date: '2026-01-10', time: '13:30', code: 'UB', sub: '', memo: '' },
    { date: '2026-01-15', time: '14:00', code: 'UB' }
  ];
  {
    const { json: saveRes } = await call('saveMonthRecords', ['2026-01', records]);
    ok('4a. saveMonthRecords 応答', saveRes.ok === true && saveRes.data.savedYm === '2026-01', saveRes);

    const { json: getRes } = await call('getMonthData', ['2026-01']);
    const got = getRes.ok ? getRes.data.records : [];
    const norm = (r) => ({ date: r.date, time: r.time, code: r.code, sub: r.sub || '', memo: r.memo || '' });
    const expect = records.map(norm).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const gotNorm = got.map(norm);
    const roundtripOk = got.length === records.length
      && JSON.stringify(gotNorm) === JSON.stringify(expect);
    ok('4b. saveMonthRecords -> getMonthData ラウンドトリップ一致', roundtripOk, { got: gotNorm, expect });
  }

  // 5. saveMonthDays(有休+日メモ)→records保存後もpaid_leave保持、逆も保持(フィールド独立性)
  {
    const days = [
      { date: '2026-01-05', paidLeave: true, memo: '' },
      { date: '2026-01-20', paidLeave: false, memo: '日メモ📝' }
    ];
    const { json: saveDaysRes } = await call('saveMonthDays', ['2026-01', days]);
    ok('5a. saveMonthDays 応答', saveDaysRes.ok === true, saveDaysRes);

    let { json: getRes } = await call('getMonthData', ['2026-01']);
    let d0105 = getRes.data.days.find((d) => d.date === '2026-01-05');
    const recordsStillThere = getRes.data.records.some((r) => r.date === '2026-01-05' && r.time === '06:00');
    ok('5b. saveMonthDays後もslots(records)保持', recordsStillThere && d0105 && d0105.paidLeave === true, { d0105, recordsStillThere });

    // records を再保存(records経由の更新)。days情報(paidLeave/memo)が保持されるか確認。
    const { json: saveRecRes } = await call('saveMonthRecords', ['2026-01', records]);
    ok('5c. saveMonthRecords 再応答', saveRecRes.ok === true, saveRecRes);
    ({ json: getRes } = await call('getMonthData', ['2026-01']));
    d0105 = getRes.data.days.find((d) => d.date === '2026-01-05');
    const d0120 = getRes.data.days.find((d) => d.date === '2026-01-20');
    ok('5d. saveMonthRecords後もdays(有休・日メモ)保持', !!d0105 && d0105.paidLeave === true && !!d0120 && d0120.memo === '日メモ📝', { d0105, d0120 });
  }

  // 6. 全消し(空records+空days)→行がDELETEされている(直接SQLで確認)
  {
    await call('saveMonthRecords', ['2026-01', []]);
    await call('saveMonthDays', ['2026-01', []]);
    const rows = d1Query("SELECT date FROM days WHERE date LIKE '2026-01-%'");
    ok('6. 全消し後にdays行が0件', rows.length === 0, rows);
  }

  // 7. saveCategories/saveImportMapのラウンドトリップ
  {
    const cats = [
      { code: 'UB', name: '派遣先業務', parent: '', color: '#aecde8', order: 10, active: true },
      { code: 'CN', name: '自社業務', parent: '', color: '#d9c2e9', order: 20, active: false }
    ];
    const { json: saveCatRes } = await call('saveCategories', [cats]);
    ok('7a. saveCategories 応答', saveCatRes.ok === true && saveCatRes.data.count === 2, saveCatRes);
    const { json: getRes } = await call('getMonthData', ['2026-02']);
    const gotCats = getRes.data.categories;
    ok('7b. saveCategories ラウンドトリップ', JSON.stringify(gotCats) === JSON.stringify(cats), gotCats);

    const map = [{ title: 'テスト予定', code: 'UB', sub: '' }];
    const { json: saveMapRes } = await call('saveImportMap', [map]);
    ok('7c. saveImportMap 応答', saveMapRes.ok === true && saveMapRes.data.count === 1, saveMapRes);
    const { json: listRes } = await call('listCalendarEvents', ['2026-02']);
    const importMapOk = !listRes.ok && /カレンダー連携に失敗しました/.test(listRes.error || '');
    // ダミーGAS_URLのため events 部分は失敗するが、importMap確認は別途D1直読みで行う
    const rows = d1Query("SELECT title, code, sub FROM import_map WHERE title = 'テスト予定'");
    ok('7d. saveImportMap ラウンドトリップ(D1直読み)', rows.length === 1 && rows[0].code === 'UB', rows);
    ok('7e. (参考)listCalendarEventsはダミーGAS_URLのため失敗する', importMapOk, listRes);
  }

  // 8. listCalendarEvents→GAS_URLダミーのため{ok:false,error:…}がクラッシュせず返る
  {
    const res = await fetch(BASE + '/api', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: TOKEN, fn: 'listCalendarEvents', args: ['2026-02'] })
    });
    const json = await res.json();
    ok('8. listCalendarEvents失敗時もHTTP200・ok:falseでクラッシュしない', res.status === 200 && json.ok === false, { status: res.status, json });
  }

  // 9. 時刻 '9:00' を含むsaveMonthRecords -> getMonthDataで '09:00' に正規化されて返る(⑪)
  {
    await call('saveMonthRecords', ['2026-03', []]); // 対象月をクリーンな状態にする
    const { json: saveRes } = await call('saveMonthRecords', ['2026-03', [
      { date: '2026-03-01', time: '9:00', code: 'UB' }
    ]]);
    ok('9a. saveMonthRecords(1桁時刻) 応答', saveRes.ok === true, saveRes);
    const { json: getRes } = await call('getMonthData', ['2026-03']);
    const rec = getRes.ok ? getRes.data.records.find((r) => r.date === '2026-03-01') : null;
    ok('9b. 1桁時刻 9:00 が 09:00 に正規化される', !!rec && rec.time === '09:00', rec);
  }

  // 10. saveMonthDaysだけを空にしたとき、slots(records)が残っている日は行が残り
  //     paid_leave/memoだけクリアされる(フィールド独立性。GAS.txt移植の退行防止)
  {
    await call('saveMonthRecords', ['2026-04', []]);
    await call('saveMonthDays', ['2026-04', []]);
    await call('saveMonthRecords', ['2026-04', [
      { date: '2026-04-05', time: '10:00', code: 'UB' }
    ]]);
    await call('saveMonthDays', ['2026-04', [
      { date: '2026-04-05', paidLeave: true, memo: 'テストメモ' }
    ]]);
    await call('saveMonthDays', ['2026-04', []]); // daysだけ空にする
    const { json: getRes } = await call('getMonthData', ['2026-04']);
    const rec = getRes.ok ? getRes.data.records.find((r) => r.date === '2026-04-05') : null;
    // getMonthData.js(既存・本タスク未変更)の days 配列は GAS互換で
    // 「paid_leave=1 または memo非空」の行のみを返す仕様(41行目)のため、クリア後
    // (paid_leave=0, memo='')の行は days 配列に出ない(想定どおり。行自体が消えたわけではない)。
    // 行の生死とpaid_leave/memoクリアはD1を直接読み(項目6/7d/11bと同じ手法)、
    // slots保持はgetMonthData().records で確認する。
    const rows = d1Query("SELECT slots, paid_leave, memo FROM days WHERE date = '2026-04-05'");
    let rowOk = false;
    if (rows.length === 1) {
      let slots = {};
      try { slots = JSON.parse(rows[0].slots); } catch (e) { slots = {}; }
      rowOk = rows[0].paid_leave === 0 && rows[0].memo === '' && !!slots['10:00'] && slots['10:00'].code === 'UB';
    }
    ok('10. saveMonthDaysのみ空 -> slotsは残り paid_leave/memoだけクリア(D1直読み)',
      !!rec && rec.code === 'UB' && rows.length === 1 && rowOk, { rec, rows });
  }

  // 11. 月外レコード(ym='2026-01'にdate:'2025-12-31'を混ぜる)がその日付の行へスロット単位で
  //     マージされ、同日の既存slots・memoが保持される(⑤: 旧GASからの退行防止)
  {
    // 事前に2025-12-31へ既存slot+memoを仕込む(2025-12月として保存)
    await call('saveMonthRecords', ['2025-12', []]);
    await call('saveMonthDays', ['2025-12', []]);
    await call('saveMonthRecords', ['2025-12', [
      { date: '2025-12-31', time: '08:00', code: 'UB' }
    ]]);
    await call('saveMonthDays', ['2025-12', [
      { date: '2025-12-31', paidLeave: false, memo: '既存メモ' }
    ]]);

    // ym='2026-01' のsaveMonthRecordsに月外(2025-12-31)のスロットを混ぜて保存
    await call('saveMonthRecords', ['2026-01', []]);
    const { json: saveRes } = await call('saveMonthRecords', ['2026-01', [
      { date: '2025-12-31', time: '09:00', code: 'CN' }
    ]]);
    ok('11a. 月外レコードを混ぜたsaveMonthRecords 応答', saveRes.ok === true, saveRes);

    const rows = d1Query("SELECT date, slots, memo FROM days WHERE date = '2025-12-31'");
    let slotsOk = false;
    let keys = [];
    if (rows.length === 1) {
      const slots = JSON.parse(rows[0].slots);
      keys = Object.keys(slots).sort();
      slotsOk = keys.join(',') === '08:00,09:00' && rows[0].memo === '既存メモ';
    }
    ok('11b. 月外日付にスロットがマージされ既存slots/memoが保持される', rows.length === 1 && slotsOk, { rows, keys });
  }

  // 12. fn:'constructor' がprototype経由で解決されず、不明なAPIとして拒否される(⑩)
  {
    const { json } = await call('constructor', []);
    ok('12. fn=constructor は不明なAPIとして拒否される', json && json.ok === false && /不明なAPI/.test(json.error || ''), json);
  }

  // 13. listWeekData(ダミーGAS_URLのため) -> ok:falseかつ「カレンダー連携に失敗しました」で
  //     始まるエラー文言で返り、クラッシュしない(③)
  {
    const { json } = await call('listWeekData', ['2026-02-01', '2026-02-07']);
    ok('13. listWeekDataはダミーGAS_URLのため失敗するがクラッシュしない',
      json && json.ok === false && /^カレンダー連携に失敗しました/.test(json.error || ''), json);
  }

  console.log('---');
  console.log(failed === 0 ? 'ALL PASS' : `${failed} 件 FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('スモーク実行中に例外:', e);
  process.exit(1);
});
