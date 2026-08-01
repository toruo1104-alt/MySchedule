/**
 * 月ブロック置換(記録)。移植元: GAS.txt 311-330行 saveMonthRecords。
 * D1では1日1行(days.slots にJSON)のため、対象月の各日について
 * 「slotsのみ置換・paid_leave/memoは保持」する。全消しの日はDELETE。
 *
 * 対象月以外の日付を持つレコード(⑤: カレンダー取込で前月末開始の予定を取り込むと発生しうる。
 * 旧GAS(GAS.txt 311-330行)は月外行も保存していたための互換)は無視せず、その日付の行へ
 * スロット単位でマージする(渡された時刻キーだけ上書き追加。既存の他スロット・paid_leave・memoは保持)。
 */
import { fmtTime } from '../db.js';

export async function saveMonthRecords(db, env, ym, records) {
  ym = String(ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('不正な年月指定: ' + ym);
  const prefix = ym + '-';

  const { results } = await db.prepare(
    'SELECT date, slots, paid_leave, memo FROM days WHERE date LIKE ?'
  ).bind(prefix + '%').all();
  const existing = new Map();
  for (const row of results) existing.set(row.date, row);

  const byDate = new Map(); // 対象月内: 月ブロック置換
  const outsideByDate = new Map(); // 対象月外: スロット単位マージ(⑤)
  (records || []).forEach((r) => {
    if (!r || !r.date || !r.time || !r.code) return; // 区分なしスロットは保存しない
    const date = String(r.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return; // 不正な日付形式はスキップ(⑪)
    const time = fmtTime(String(r.time)); // 時刻キーを HH:mm へ正規化(⑪)
    const entry = { code: String(r.code) };
    if (r.sub) entry.sub = String(r.sub);
    if (r.memo) entry.memo = String(r.memo);
    if (date.indexOf(prefix) === 0) {
      if (!byDate.has(date)) byDate.set(date, {});
      byDate.get(date)[time] = entry;
    } else {
      if (!outsideByDate.has(date)) outsideByDate.set(date, {});
      outsideByDate.get(date)[time] = entry;
    }
  });

  const targetDates = new Set([...existing.keys(), ...byDate.keys()]);
  const stmts = [];
  for (const date of targetDates) {
    const slotsJson = JSON.stringify(byDate.get(date) || {});
    const old = existing.get(date);
    const paidLeave = old ? (old.paid_leave === 1 ? 1 : 0) : 0;
    const memo = old ? String(old.memo || '') : '';

    if (slotsJson === '{}' && paidLeave === 0 && memo === '') {
      if (old) stmts.push(db.prepare('DELETE FROM days WHERE date = ?').bind(date));
      continue;
    }
    stmts.push(
      db.prepare(
        'INSERT INTO days (date, slots, paid_leave, memo) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(date) DO UPDATE SET slots = excluded.slots'
      ).bind(date, slotsJson, paidLeave, memo)
    );
  }

  // 月外レコード(⑤): その日付の既存行を読み、渡された時刻キーだけ上書きしてマージする
  if (outsideByDate.size) {
    const outsideDates = [...outsideByDate.keys()];
    const placeholders = outsideDates.map(() => '?').join(',');
    const { results: outsideRows } = await db.prepare(
      `SELECT date, slots, paid_leave, memo FROM days WHERE date IN (${placeholders})`
    ).bind(...outsideDates).all();
    const outsideExisting = new Map();
    for (const row of outsideRows) outsideExisting.set(row.date, row);

    for (const date of outsideDates) {
      const old = outsideExisting.get(date);
      let slots = {};
      if (old && old.slots) {
        try { slots = JSON.parse(old.slots) || {}; } catch (e) { slots = {}; }
      }
      const incoming = outsideByDate.get(date);
      for (const time of Object.keys(incoming)) slots[time] = incoming[time];
      const paidLeave = old ? (old.paid_leave === 1 ? 1 : 0) : 0;
      const memo = old ? String(old.memo || '') : '';
      stmts.push(
        db.prepare(
          'INSERT INTO days (date, slots, paid_leave, memo) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(date) DO UPDATE SET slots = excluded.slots'
        ).bind(date, JSON.stringify(slots), paidLeave, memo)
      );
    }
  }

  if (stmts.length) await db.batch(stmts);

  return { ok: true, savedYm: ym };
}
