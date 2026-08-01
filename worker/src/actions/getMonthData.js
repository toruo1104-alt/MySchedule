/**
 * 月データ一括取得。ym = 'yyyy-MM'
 * 移植元: GAS.txt 200-217行 getMonthData。出力キー{ym,config,categories,records,days,holidays}は同一。
 * records は days.slots(JSON)を {date,time,code,sub,memo} へ展開して作る(日付・時刻昇順)。
 */
import { readConfig, readCategories } from '../db.js';
import { ensureHolidaysForYear, readHolidaysForMonth } from '../holidays.js';

export async function getMonthData(db, env, ym) {
  ym = String(ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('不正な年月指定: ' + ym);

  const year = parseInt(ym.substring(0, 4), 10);
  await ensureHolidaysForYear(db, env, year);
  await ensureHolidaysForYear(db, env, year + 1);

  const config = await readConfig(db);
  const categories = await readCategories(db);

  const { results } = await db.prepare(
    'SELECT date, slots, paid_leave, memo FROM days WHERE date LIKE ? ORDER BY date ASC'
  ).bind(ym + '-%').all();

  const records = [];
  const days = [];
  for (const row of results) {
    let slots = {};
    try { slots = JSON.parse(row.slots || '{}'); } catch (e) { slots = {}; }
    const times = Object.keys(slots).sort();
    for (const time of times) {
      const s = slots[time] || {};
      if (!s.code) continue;
      records.push({
        date: row.date,
        time,
        code: String(s.code),
        sub: String(s.sub || ''),
        memo: String(s.memo || '')
      });
    }
    if (row.paid_leave === 1 || (row.memo && row.memo !== '')) {
      days.push({ date: row.date, paidLeave: row.paid_leave === 1, memo: String(row.memo || '') });
    }
  }

  const holidays = await readHolidaysForMonth(db, ym);

  return { ym, config, categories, records, days, holidays };
}
