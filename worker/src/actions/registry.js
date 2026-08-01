/**
 * fn名 → ハンドラの一元マップ。index.js はこのマップだけを見て実行する。
 * ハンドラのシグネチャ: handler(db, env, ...args) -> Promise<data>(argsはreq.argsをそのまま展開)
 */
import { getMonthData } from './getMonthData.js';
import { saveMonthRecords } from './saveMonthRecords.js';
import { saveMonthDays } from './saveMonthDays.js';
import { saveCategories } from './saveCategories.js';
import { saveImportMap } from './saveImportMap.js';
import { listCalendarEvents } from './listCalendarEvents.js';
import { listWeekData } from './listWeekData.js';

export const registry = {
  getMonthData,
  saveMonthRecords,
  saveMonthDays,
  saveCategories,
  listCalendarEvents,
  saveImportMap,
  listWeekData
};
