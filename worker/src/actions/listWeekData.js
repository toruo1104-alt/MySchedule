/**
 * 週ビュー用一括取得。移植元: GAS.txt 484-505行 listWeekData。
 * イベント・タスクはGASプロキシ(fn: listWeekData, args:[from,to,calendarIds])経由、
 * 祝日はD1(holidays)から範囲分を返す(両端年をensure)。
 * GAS応答(events/tasks/tasksAvailable)はアイソレートメモリキャッシュに保持し(キー from|to、
 * TTL5分・上限50件)、ヒット時はGASを呼ばずD1祝日だけ合成して返す。第4引数fresh(truthy)が
 * 来たらキャッシュを無視して取得し直し、結果でキャッシュを上書きする。
 */
import { readConfig } from '../db.js';
import { callGasProxy } from '../gasProxy.js';
import { ensureHolidaysForYear, readHolidaysForRange } from '../holidays.js';

const WEEK_DATA_CACHE_TTL_MS = 5 * 60 * 1000;
const WEEK_DATA_CACHE_MAX_ENTRIES = 50;
const weekDataCache = new Map(); // "from|to" -> {value:{events,tasks,tasksAvailable}, ts}

function weekDataCacheGet(key) {
  const entry = weekDataCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > WEEK_DATA_CACHE_TTL_MS) { weekDataCache.delete(key); return null; }
  return entry.value;
}

function weekDataCacheSet(key, value) {
  weekDataCache.delete(key); // 既存キーなら一旦消してから入れ直し、Mapの挿入順を最新化する(単純なLRU代わり)
  weekDataCache.set(key, { value, ts: Date.now() });
  if (weekDataCache.size > WEEK_DATA_CACHE_MAX_ENTRIES) {
    const oldestKey = weekDataCache.keys().next().value;
    weekDataCache.delete(oldestKey);
  }
}

function parseYmd(s) {
  const p = s.split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

export async function listWeekData(db, env, from, to, fresh) {
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

  const cacheKey = from + '|' + to;
  let result = fresh ? null : weekDataCacheGet(cacheKey);

  if (!result) {
    const config = await readConfig(db);
    let data;
    try {
      data = await callGasProxy(env, 'listWeekData', [from, to, config.calendarIds]);
    } catch (e) {
      throw new Error('カレンダー連携に失敗しました: ' + (e && e.message ? e.message : e));
    }
    result = {
      events: (data && data.events) || [],
      tasks: (data && data.tasks) || [],
      tasksAvailable: !!(data && data.tasksAvailable)
    };
    weekDataCacheSet(cacheKey, result);
  }

  const holidays = await readHolidaysForRange(db, from, to);

  return {
    events: result.events,
    tasks: result.tasks,
    tasksAvailable: result.tasksAvailable,
    holidays
  };
}
