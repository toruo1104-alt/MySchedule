/**
 * config / categories / import_map の共通読み取り。
 * 出力キー・型は現GAS.txtの readConfig_(228-243行) / readCategories_(245-262行) /
 * readImportMap_(446-455行) に一字一句合わせる(apiTokenのみ env.API_TOKEN 側へ移行のため除く)。
 */

// Date型を持たないD1向けの 'HH:mm' 正規化(GAS.txt fmtTime_ の簡略版)。
// saveMonthRecords.js からも共用する(⑪: 保存時の時刻キー正規化)。
export function fmtTime(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return pad2(m[1]) + ':' + m[2];
  return s;
}

function pad2(n) {
  const s = String(n);
  return s.length < 2 ? '0' + s : s;
}

export async function readConfig(db) {
  const { results } = await db.prepare('SELECT key, value FROM config').all();
  const out = {};
  for (const r of results) out[r.key] = r.value;
  return {
    dayStart: fmtTime(out.dayStart || '06:00'),
    dayEnd: fmtTime(out.dayEnd || '22:00'),
    ownHoursPerDay: Number(out.ownHoursPerDay) || 8,
    clientHoursPerDay: Number(out.clientHoursPerDay) || 7.5,
    clientWorkCode: String(out.clientWorkCode || 'UB'),
    manMonthRatio: (out.manMonthRatio === '' || out.manMonthRatio == null) ? 0.6 : (Number(out.manMonthRatio) || 0.6),
    calendarIds: String(out.calendarIds || '')
  };
}

export async function readCategories(db) {
  const { results } = await db.prepare(
    'SELECT code, name, parent, color, sort, active FROM categories ORDER BY sort ASC, id ASC'
  ).all();
  return results.map((r) => ({
    code: String(r.code),
    name: String(r.name || ''),
    parent: String(r.parent || ''),
    color: String(r.color || ''),
    order: Number(r.sort) || 0,
    active: r.active === 1 || r.active === true
  }));
}

export async function readImportMap(db) {
  const { results } = await db.prepare('SELECT title, code, sub FROM import_map').all();
  const out = {};
  for (const r of results) {
    out[r.title] = { code: String(r.code || ''), sub: String(r.sub || '') };
  }
  return out;
}
