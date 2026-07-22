/* ============================================================
   MySchedule — ローカルプレビュー用モック (GASへは持っていかない)

   GAS API を window.__MYSCHEDULE_MOCK__ として模擬する(app.js の
   serverCall がこれを見つけると fetch せずにこちらを呼ぶ)。
   データは localStorage に保存され、塗り→保存→月切替を確認できる。
   リセットしたいときは DevTools で
     localStorage.removeItem('myschedule-mock')
============================================================ */
(function () {
  "use strict";

  var LS_KEY = "myschedule-mock";
  var LATENCY_MS = 250; // GAS呼び出しの遅延を模擬

  /* ---- 2026年の日本の祝日(モック用。本番はGoogleカレンダーから取得) ---- */
  var HOLIDAYS_2026 = {
    "2026-01-01": "元日", "2026-01-12": "成人の日", "2026-02-11": "建国記念の日",
    "2026-02-23": "天皇誕生日", "2026-03-20": "春分の日", "2026-04-29": "昭和の日",
    "2026-05-03": "憲法記念日", "2026-05-04": "みどりの日", "2026-05-05": "こどもの日",
    "2026-05-06": "振替休日", "2026-07-20": "海の日", "2026-08-11": "山の日",
    "2026-09-21": "敬老の日", "2026-09-22": "国民の休日", "2026-09-23": "秋分の日",
    "2026-10-12": "スポーツの日", "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日"
  };

  var DEFAULT_CATEGORIES = [
    { code: "UB", name: "派遣先業務", parent: "", color: "#aecde8", order: 10, active: true },
    { code: "CN", name: "自社業務", parent: "", color: "#d9c2e9", order: 20, active: true },
    { code: "BT", name: "ベテル奉仕", parent: "", color: "#c9e3b4", order: 30, active: true },
    { code: "FS", name: "奉仕", parent: "", color: "#ffe699", order: 40, active: true },
    { code: "MT", name: "集会", parent: "", color: "#f4b8b8", order: 50, active: true },
    { code: "CW", name: "会衆の仕事", parent: "", color: "#f8cbad", order: 60, active: true },
    { code: "ST", name: "勉強", parent: "", color: "#b4dcd8", order: 70, active: true },
    { code: "ST1", name: "個人研究", parent: "ST", color: "", order: 71, active: true },
    { code: "ST2", name: "割当準備", parent: "ST", color: "", order: 72, active: true },
    { code: "ST3", name: "聖書通読", parent: "ST", color: "", order: 73, active: true },
    { code: "ST4", name: "集会予習", parent: "ST", color: "", order: 74, active: true },
    { code: "FX", name: "フレックス", parent: "", color: "#e2e8cf", order: 80, active: true },
    { code: "FX1", name: "料理", parent: "FX", color: "", order: 81, active: true },
    { code: "FX2", name: "掃除", parent: "FX", color: "", order: 82, active: true },
    { code: "FX3", name: "洗濯", parent: "FX", color: "", order: 83, active: true },
    { code: "FX4", name: "エクササイズ", parent: "FX", color: "", order: 84, active: true },
    { code: "FX5", name: "レク", parent: "FX", color: "", order: 85, active: true },
    { code: "mv", name: "移動", parent: "", color: "#d9d9d9", order: 90, active: true }
  ];

  /* ---- DB(localStorage) ---- */

  function loadDb() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 壊れていたら作り直す */ }
    return seedDb();
  }

  function saveDb(db) {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  }

  // 初期サンプル: 今月の最初の平日3日分にそれらしい記録を入れる
  function seedDb() {
    var db = { categories: DEFAULT_CATEGORIES, records: [], days: [] };
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    var seeded = 0;
    for (var d = 1; d <= 28 && seeded < 3; d++) {
      var dt = new Date(y, m, d);
      var dow = dt.getDay();
      var dateStr = ymd(dt);
      if (dow === 0 || dow === 6 || HOLIDAYS_2026[dateStr]) continue;
      pushRange(db, dateStr, "09:00", "12:00", "UB", "", seeded === 0 ? "浜北" : "");
      pushRange(db, dateStr, "13:00", "17:30", "UB", "", "");
      pushRange(db, dateStr, "18:30", "19:30", "ST", "ST1", "");
      if (seeded === 1) pushRange(db, dateStr, "19:30", "21:00", "MT", "", "");
      seeded++;
    }
    return db;
  }

  function pushRange(db, date, from, to, code, sub, memo) {
    for (var t = toMin(from); t < toMin(to); t += 30) {
      db.records.push({ date: date, time: toHm(t), code: code, sub: sub, memo: memo });
    }
  }

  /* ---- API 実装(GAS.txt と同じ入出力) ---- */

  var api = {
    getMonthData: function (ym) {
      var db = loadDb();
      var holidays = {};
      Object.keys(HOLIDAYS_2026).forEach(function (d) {
        if (d.indexOf(ym + "-") === 0) holidays[d] = HOLIDAYS_2026[d];
      });
      return {
        ym: ym,
        config: {
          dayStart: "06:00", dayEnd: "22:00",
          ownHoursPerDay: 8, clientHoursPerDay: 7.5,
          clientWorkCode: "UB", manMonthRatio: 0.6, calendarIds: ""
        },
        categories: db.categories.slice().sort(function (a, b) { return a.order - b.order; }),
        records: db.records.filter(function (r) { return r.date.indexOf(ym + "-") === 0; }),
        days: db.days.filter(function (d) { return d.date.indexOf(ym + "-") === 0; }),
        holidays: holidays
      };
    },

    saveMonthRecords: function (ym, records) {
      var db = loadDb();
      db.records = db.records.filter(function (r) { return r.date.indexOf(ym + "-") !== 0; })
        .concat(records || []);
      saveDb(db);
      return { ok: true, savedYm: ym };
    },

    saveMonthDays: function (ym, days) {
      var db = loadDb();
      db.days = db.days.filter(function (d) { return d.date.indexOf(ym + "-") !== 0; })
        .concat(days || []);
      saveDb(db);
      return { ok: true, savedYm: ym };
    },

    saveCategories: function (categories) {
      var db = loadDb();
      db.categories = categories || [];
      saveDb(db);
      return { ok: true, count: (categories || []).length };
    }
  };

  /* ---- serverCall フック(app.js が参照する) ---- */

  window.__MYSCHEDULE_MOCK__ = {
    call: function (fnName, args) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try {
            if (!api[fnName]) throw new Error("不明なAPI: " + fnName);
            resolve(api[fnName].apply(null, args || []));
          } catch (e) {
            reject(e);
          }
        }, LATENCY_MS);
      });
    }
  };

  /* ---- ユーティリティ ---- */
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function toMin(hm) { var p = hm.split(":"); return +p[0] * 60 + +p[1]; }
  function toHm(min) { return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60); }

  console.log("[mock] MySchedule プレビューモード(データは localStorage に保存)");
})();
