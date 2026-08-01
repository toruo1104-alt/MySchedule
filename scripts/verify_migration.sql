-- scripts/verify_migration.sql — seed.sql 投入後の検証クエリ集
-- 実行例: npx wrangler d1 execute DB --local --file=../scripts/verify_migration.sql
--        (本番投入後の検証は --local を --remote に変える)
--
-- 期待値は json_to_sql.mjs 実行時に標準出力へ出る件数、および seed.sql 末尾の
-- `-- EXPECT days=<n> slots_total=<n> categories=<n> config=<n> import_map=<n> holidays=<n>`
-- コメントの値と一致すること。

-- 1) 各テーブルの件数
-- ★D1(ローカル含む)は compound SELECT(UNION ALL)の項数を厳しく制限しており、
--   複数項のUNION ALLは環境によって "too many terms in compound SELECT" で失敗することがある
--   (sk-visit-map-DBver での実績を踏襲)。そのため意図的にUNION ALLでまとめず、
--   テーブルごとに単独のSELECT文にしている。
SELECT COUNT(*) AS cnt FROM days;
SELECT COUNT(*) AS cnt FROM categories;
SELECT COUNT(*) AS cnt FROM config;
SELECT COUNT(*) AS cnt FROM import_map;
SELECT COUNT(*) AS cnt FROM holidays;

-- 2) days.slots が JSON として妥当か(json_valid()<>1 の行数。0件が期待値)
SELECT date, slots
FROM days
WHERE json_valid(slots) <> 1
LIMIT 20;

SELECT COUNT(*) AS invalid_slots_cnt
FROM days
WHERE json_valid(slots) <> 1;

-- 3) days.slots のキー総数(スロット総数)の合計。seed.sql末尾のEXPECT slots_total と突き合わせる
SELECT COUNT(*) AS slots_total
FROM days, json_each(days.slots)
WHERE json_valid(days.slots) = 1;

-- 4) 重複チェック(結果が0件であることを期待。PRIMARY KEYなので本来発生しないが、
--    INSERT時の意図せぬ上書きが無いか確認)
SELECT date, COUNT(*) AS cnt FROM days GROUP BY date HAVING COUNT(*) > 1;
SELECT code, COUNT(*) AS cnt FROM categories GROUP BY code HAVING COUNT(*) > 1;
SELECT key, COUNT(*) AS cnt FROM config GROUP BY key HAVING COUNT(*) > 1;
SELECT title, COUNT(*) AS cnt FROM import_map GROUP BY title HAVING COUNT(*) > 1;
SELECT date, COUNT(*) AS cnt FROM holidays GROUP BY date HAVING COUNT(*) > 1;

-- 5) config に apiToken が無いことの確認(D1へは移行せずWorkers Secretへ。0件が期待値)
SELECT COUNT(*) AS apitoken_cnt FROM config WHERE key = 'apiToken';

-- 7) 形式検査(①: 設定シートのDate型時刻の文字化けがD1側に残っていないかの最終確認。
--    いずれも0件が期待値。json_to_sql.mjs側でエラー停止するはずだが、手投入等の混入に備えた保険)
-- 7a) days.date が yyyy-MM-dd 形式に一致しない行数
SELECT COUNT(*) AS invalid_days_date_cnt
FROM days
WHERE date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';

-- 7b) config の dayStart/dayEnd が HH:mm 形式に一致しない行数
SELECT COUNT(*) AS invalid_config_time_cnt
FROM config
WHERE key IN ('dayStart', 'dayEnd')
  AND value NOT GLOB '[0-9][0-9]:[0-9][0-9]';

-- 7c) days.slots の時刻キー(json_eachのkey)が HH:mm 形式に一致しない件数
SELECT COUNT(*) AS invalid_slot_key_cnt
FROM days, json_each(days.slots)
WHERE json_valid(days.slots) = 1
  AND key NOT GLOB '[0-9][0-9]:[0-9][0-9]';

-- 6) サンプル行の目視確認(全列突合の足がかり)
SELECT * FROM days ORDER BY date LIMIT 5;
SELECT * FROM categories ORDER BY sort LIMIT 5;
SELECT * FROM config ORDER BY key LIMIT 5;
SELECT * FROM import_map ORDER BY title LIMIT 5;
SELECT * FROM holidays ORDER BY date LIMIT 5;
