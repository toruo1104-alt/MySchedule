/**
 * 週ビュー用一括取得。移植元: GAS.txt 484-505行 listWeekData。
 * イベント・タスクはGASプロキシ(fn: listWeekData, args:[from,to,calendarIds])経由、
 * 祝日はD1(holidays)から範囲分を返す(両端年をensure)。
 */
import { readConfig } from '../db.js';
import { callGasProxy } from '../gasProxy.js';
import { ensureHolidaysForYear, readHolidaysForRange } from '../holidays.js';

function parseYmd(s) {
  const p = s.split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

export async function listWeekData(db, env, from, to) {
  from = String(from || '');
  to = String(to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('不正な日付指定: ' + from + ' 〜 ' + to);
  }
  const fromDate = parseYmd(from);
  const toDate = parseYmd(to);
  const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
  if (days < 1 || days > 14) throw new Error('不正な範囲です(1〜14日): ' + from + ' 〜 ' + to);

  await ensureHolidaysForYear(db, env, fromDate.getFullYear());
  await ensureHolidaysForYear(db, env, toDate.getFullYear());

  const config = await readConfig(db);
  let data;
  try {
    data = await callGasProxy(env, 'listWeekData', [from, to, config.calendarIds]);
  } catch (e) {
    throw new Error('カレンダー連携に失敗しました: ' + (e && e.message ? e.message : e));
  }
  const holidays = await readHolidaysForRange(db, from, to);

  return {
    events: (data && data.events) || [],
    tasks: (data && data.tasks) || [],
    tasksAvailable: !!(data && data.tasksAvailable),
    holidays
  };
}
