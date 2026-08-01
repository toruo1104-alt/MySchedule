/**
 * 月ブロック置換(日次: 有休・日メモ)。移植元: GAS.txt 332-351行 saveMonthDays。
 * saveMonthRecords と対称: 「paid_leave/memoのみ置換・slotsは保持」。
 * 月ブロック置換のため、既存行で今回の days 配列に含まれない日は有休/メモをクリアする。
 *
 * 対象月以外の日付を持つエントリ(⑤: saveMonthRecords.js と同じ理由で発生しうる)は無視せず、
 * その日付の paid_leave/memo を設定する(slotsは保持)。ただし月外は「クリア」しない
 * (月ブロック置換の対象外のため、渡された日付分だけ反映し、渡されなかった月外の既存行はそのまま)。
 */
export async function saveMonthDays(db, env, ym, days) {
  ym = String(ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('不正な年月指定: ' + ym);
  const prefix = ym + '-';

  const { results } = await db.prepare(
    'SELECT date, slots, paid_leave, memo FROM days WHERE date LIKE ?'
  ).bind(prefix + '%').all();
  const existing = new Map();
  for (const row of results) existing.set(row.date, row);

  const byDate = new Map(); // 対象月内: 月ブロック置換
  const outsideByDate = new Map(); // 対象月外: 渡された分だけ反映(クリアしない)
  (days || []).forEach((d) => {
    if (!d || !d.date) return;
    const date = String(d.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return; // 不正な日付形式はスキップ
    const entry = { paidLeave: !!d.paidLeave, memo: String(d.memo || '') };
    if (date.indexOf(prefix) === 0) byDate.set(date, entry);
    else outsideByDate.set(date, entry);
  });

  const targetDates = new Set([...existing.keys(), ...byDate.keys()]);
  const stmts = [];
  for (const date of targetDates) {
    const old = existing.get(date);
    const slotsJson = old ? String(old.slots || '{}') : '{}';
    const entry = byDate.get(date) || { paidLeave: false, memo: '' };
    const paidLeave = entry.paidLeave ? 1 : 0;
    const memo = entry.memo || '';

    if (slotsJson === '{}' && paidLeave === 0 && memo === '') {
      if (old) stmts.push(db.prepare('DELETE FROM days WHERE date = ?').bind(date));
      continue;
    }
    stmts.push(
      db.prepare(
        'INSERT INTO days (date, slots, paid_leave, memo) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(date) DO UPDATE SET paid_leave = excluded.paid_leave, memo = excluded.memo'
      ).bind(date, slotsJson, paidLeave, memo)
    );
  }

  // 月外days(⑤): クリアしない。渡された日付だけ paid_leave/memo を設定(slotsは保持)
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
      const slotsJson = old ? String(old.slots || '{}') : '{}';
      const entry = outsideByDate.get(date);
      const paidLeave = entry.paidLeave ? 1 : 0;
      const memo = entry.memo || '';

      if (slotsJson === '{}' && paidLeave === 0 && memo === '') {
        if (old) stmts.push(db.prepare('DELETE FROM days WHERE date = ?').bind(date));
        continue;
      }
      stmts.push(
        db.prepare(
          'INSERT INTO days (date, slots, paid_leave, memo) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(date) DO UPDATE SET paid_leave = excluded.paid_leave, memo = excluded.memo'
        ).bind(date, slotsJson, paidLeave, memo)
      );
    }
  }

  if (stmts.length) await db.batch(stmts);

  return { ok: true, savedYm: ym };
}
