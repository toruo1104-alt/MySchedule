/**
 * 祝日キャッシュ(D1 holidays)。GAS.txt 597-623行 ensureHolidaysForYear_ 相当だが、
 * WorkerにはCalendarApp相当が無いためGASプロキシ経由(fn: getHolidays, args:[year])で取得する。
 * 取得失敗は握りつぶし、既存キャッシュのみで動作継続する(GAS版と同じ方針)。
 */
import { callGasProxy } from './gasProxy.js';

// この年は今回のアイソレート内で既にensure試行済み(成功・空・失敗いずれも記録)。
// 恒久キャッシュはD1(holidays行)が担うが、D1に0件(=空の年)の場合は「未取得」と区別が付かず
// 同一リクエスト内・同一アイソレートの再往復でGASプロキシへ毎回fetchしてしまうため、
// このモジュールレベルのSetで「試行済み」を負キャッシュする。
const attemptedYears = new Set();

export async function ensureHolidaysForYear(db, env, year) {
  const prefix = String(year) + '-';
  if (attemptedYears.has(year)) return; // 同一アイソレート内で試行済み(成功・空・失敗いずれも)

  const existing = await db.prepare('SELECT 1 FROM holidays WHERE date LIKE ? LIMIT 1').bind(prefix + '%').first();
  if (existing) {
    attemptedYears.add(year);
    return; // その年は取得済み
  }

  try {
    const data = await callGasProxy(env, 'getHolidays', [year]);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.holidays) ? data.holidays : []);
    const stmts = list
      .filter((h) => h && h.date)
      .map((h) =>
        db.prepare('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)')
          .bind(String(h.date), String(h.name || '祝日'))
      );
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    // 取得失敗でもアプリは動作継続(祝日なし or 過年度キャッシュで表示)
  } finally {
    attemptedYears.add(year);
  }
}

export async function readHolidaysForMonth(db, ym) {
  const { results } = await db.prepare('SELECT date, name FROM holidays WHERE date LIKE ?').bind(ym + '-%').all();
  const out = {};
  for (const r of results) out[r.date] = String(r.name || '祝日');
  return out;
}

export async function readHolidaysForRange(db, from, to) {
  const { results } = await db.prepare('SELECT date, name FROM holidays WHERE date >= ? AND date < ?')
    .bind(from, to).all();
  const out = {};
  for (const r of results) out[r.date] = String(r.name || '祝日');
  return out;
}
