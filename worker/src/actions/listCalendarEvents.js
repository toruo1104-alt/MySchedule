/**
 * その月のカレンダー予定一覧+タイトル→区分の記憶。移植元: GAS.txt 401-444行 listCalendarEvents。
 * WorkerにはCalendarApp相当が無いためGASプロキシ経由(fn: listCalendarEvents, args:[ym, calendarIds])で取得する。
 * importMapはD1(import_map)から返す。プロキシ呼び出し失敗は「カレンダー連携に失敗しました」で包んで
 * 上位(index.jsのcatch)に投げる(クラッシュせず{ok:false,error}として返る)。
 */
import { readConfig, readImportMap } from '../db.js';
import { callGasProxy } from '../gasProxy.js';

export async function listCalendarEvents(db, env, ym) {
  ym = String(ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('不正な年月指定: ' + ym);

  const config = await readConfig(db);
  let events;
  try {
    const data = await callGasProxy(env, 'listCalendarEvents', [ym, config.calendarIds]);
    events = Array.isArray(data) ? data : ((data && Array.isArray(data.events)) ? data.events : []);
  } catch (e) {
    throw new Error('カレンダー連携に失敗しました: ' + (e && e.message ? e.message : e));
  }

  const importMap = await readImportMap(db);
  return { events, importMap };
}
