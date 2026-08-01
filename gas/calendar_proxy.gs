/* ============================================================
   MySchedule — Calendar Proxy (gas/calendar_proxy.gs)

   フェーズ5(D1移行)のカットオーバー時に、既存GASプロジェクトの
   コード.gs を丸ごとこのファイルの内容へ置き換える。

   構成: スプレッドシート非依存(ステートレス)。Googleカレンダー・
         Google Tasksの読み取り専用の窓口として、Cloudflare Worker
         からサーバー側fetchで呼ばれる(フロントから直接は呼ばれない)。

   移行前(現行 GAS.txt)との差分:
     - token照合先: 設定シートのapiToken → ScriptProperties の 'PROXY_TOKEN'
     - listCalendarEvents: calendarIdsを設定シートから読まず引数で受け取る。
       返り値からimportMapを除外(スプレッドシート非依存のため対応不可。
       importMapはWorker側がD1から付加する)
     - listWeekData: calendarIdsを引数化。返り値からholidaysを除外
       (Worker側がD1から返す)
     - getHolidays: 新設。祝日をシートへキャッシュせず、呼ばれるたびに
       CalendarApp.getEvents()で取得して返す(キャッシュはWorker側のD1が担う)

   通信仕様(現行と同じ封筒):
     POST body(text/plain): {"token": "...", "fn": "関数名", "args": [...]}
     レスポンス(JSON):      {"ok": true, "data": ...} | {"ok": false, "error": "..."}
============================================================ */

var HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
var TZ = 'Asia/Tokyo';

// Googleカレンダー標準11色(CalendarApp.Color)→表示用hexのマップ。
// イベント自身の色が未設定(既定)の場合はカレンダー自体の色(calColorHex)にフォールバックする。
var EVENT_COLOR_HEX = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26',
  6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000'
};

/* ===== API 入口 ===== */

// 死活確認用(ブラウザでURLを開くと表示される)
function doGet() {
  return jsonOut_({ ok: true, app: 'MySchedule Calendar Proxy' });
}

function doPost(e) {
  var res;
  try {
    var req = JSON.parse(e && e.postData && e.postData.contents || '{}');
    checkToken_(req.token);
    var API = {
      listCalendarEvents: listCalendarEvents,
      listWeekData: listWeekData,
      getHolidays: getHolidays
    };
    var fn = String(req.fn || '');
    if (!API[fn]) throw new Error('不明なAPI: ' + fn);
    res = { ok: true, data: API[fn].apply(null, req.args || []) };
  } catch (err) {
    res = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return jsonOut_(res);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// トークン照合。ScriptProperties の PROXY_TOKEN と一致しなければすべて拒否
function checkToken_(token) {
  var expected = String(PropertiesService.getScriptProperties().getProperty('PROXY_TOKEN') || '');
  if (!expected) throw new Error('サーバーの PROXY_TOKEN が未設定です(setupProxyToken を実行してください)');
  // web/app.js:297 の /認証エラー|apiToken|API設定/ 正規表現に引っかかると、プロキシ側の
  // トークン不一致エラーでフロントの設定モーダルが誤って開くため、その部分文字列を含めない文言にする。
  if (String(token || '') !== expected) throw new Error('PROXY_TOKEN が一致しません');
}

// 初期セットアップ用: UUIDを生成しScriptPropertiesへ保存する(GASエディタから手動実行)。
// 実行後、ログ(表示 → ログ)に表示されたトークンをWorkerのSecret(GAS_TOKEN)へ設定する。
function setupProxyToken() {
  var token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('PROXY_TOKEN', token);
  Logger.log('PROXY_TOKEN を設定しました: ' + token);
}

/* ===== カレンダー取込API =====
   現行 GAS.txt の collectCalendars_/listCalendarEvents(382〜444行)を、
   スプレッドシート依存(calendarIdsを設定シートから読む)を除いて移植する。 */

// 取込対象カレンダー(デフォルトカレンダー+引数calendarIds、祝日カレンダーは除外)の一覧を返す。
// calendarIds はカンマ区切り文字列(現行の設定シート calendarIds と同じ形式)。
function collectCalendars_(calendarIds) {
  var calendars = [];
  var defCal = CalendarApp.getDefaultCalendar();
  if (defCal) calendars.push(defCal);
  String(calendarIds || '').split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (id) { return id && id !== HOLIDAY_CALENDAR_ID; })
    .forEach(function (id) {
      try {
        var cal = CalendarApp.getCalendarById(id);
        if (cal) calendars.push(cal);
      } catch (e) { /* 取得失敗のIDはスキップ(落とさない) */ }
    });
  return calendars;
}

// その月のカレンダーイベント一覧を返す。ym = 'yyyy-MM'。
// 現行との差分: calendarIdsを引数で受け取る/importMapを返さない(Worker側がD1から付加する)。
function listCalendarEvents(ym, calendarIds) {
  ym = String(ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('不正な年月指定: ' + ym);
  var year = parseInt(ym.substring(0, 4), 10);
  var month = parseInt(ym.substring(5, 7), 10);
  var from = new Date(year, month - 1, 1);
  var to = new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);

  var calendars = collectCalendars_(calendarIds);

  var events = [];
  calendars.forEach(function (cal) {
    var calName = cal.getName();
    var calColorHex = calendarColorHex_(cal);
    cal.getEvents(from, to).forEach(function (ev) {
      var color = eventColorHex_(ev, calColorHex);
      if (ev.isAllDayEvent()) {
        events.push({
          title: ev.getTitle(),
          start: '', end: '',
          allDay: true,
          date: Utilities.formatDate(ev.getAllDayStartDate(), TZ, 'yyyy-MM-dd'),
          calendarName: calName,
          color: color
        });
      } else {
        events.push({
          title: ev.getTitle(),
          start: Utilities.formatDate(ev.getStartTime(), TZ, 'yyyy-MM-dd HH:mm'),
          end: Utilities.formatDate(ev.getEndTime(), TZ, 'yyyy-MM-dd HH:mm'),
          allDay: false,
          date: '',
          calendarName: calName,
          color: color
        });
      }
    });
  });
  events.sort(function (a, b) {
    var ka = a.allDay ? a.date + ' 00:00' : a.start;
    var kb = b.allDay ? b.date + ' 00:00' : b.start;
    return ka === kb ? 0 : (ka < kb ? -1 : 1);
  });

  return { events: events };
}

// カレンダー自体の色をhexで返す(取得失敗時は空文字)。
// Calendar.getColor() は「#rrggbb」のhex文字列を返す仕様(イベントの1〜11インデックスとは別)なので、
// hexならそのまま採用し、万一インデックスで返る環境ではマップで変換する
function calendarColorHex_(cal) {
  try {
    var c = String(cal.getColor() || '');
    if (!c) return '';
    if (c.charAt(0) === '#') return c;
    return EVENT_COLOR_HEX[c] || '';
  } catch (e) { return ''; }
}

// イベント個別の色(未設定ならカレンダー色にフォールバック)をhexで返す
function eventColorHex_(ev, calColorHex) {
  var evColor;
  try { evColor = ev.getColor(); } catch (e) { evColor = null; }
  return evColor ? (EVENT_COLOR_HEX[evColor] || '') : (calColorHex || '');
}

/* ===== 週ビューAPI =====
   現行 GAS.txt の listWeekData/collectWeekEvents_/tasksAvailable_/collectWeekTasks_
   (484〜578行)を移植する。tasks関連はスプレッドシート非依存のため無変更。 */

// 週表示用データ一括取得。from含む・to含まない('yyyy-MM-dd')。範囲は1〜14日。
// 現行との差分: calendarIdsを引数で受け取る/holidaysを返さない(Worker側がD1から返す)。
function listWeekData(from, to, calendarIds) {
  from = String(from || '');
  to = String(to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('不正な日付指定: ' + from + ' 〜 ' + to);
  }
  var fromDate = parseYmd_(from);
  var toDate = parseYmd_(to);
  var days = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
  if (days < 1 || days > 14) throw new Error('不正な範囲です(1〜14日): ' + from + ' 〜 ' + to);

  return {
    events: collectWeekEvents_(fromDate, toDate, calendarIds),
    tasks: collectWeekTasks_(from, to),
    tasksAvailable: tasksAvailable_()
  };
}

function collectWeekEvents_(fromDate, toDate, calendarIds) {
  var calendars = collectCalendars_(calendarIds);
  var events = [];
  calendars.forEach(function (cal) {
    var calName = cal.getName();
    var calColorHex = calendarColorHex_(cal);
    cal.getEvents(fromDate, toDate).forEach(function (ev) {
      var color = eventColorHex_(ev, calColorHex);
      if (ev.isAllDayEvent()) {
        events.push({
          title: ev.getTitle(),
          start: '', end: '',
          allDay: true,
          date: Utilities.formatDate(ev.getAllDayStartDate(), TZ, 'yyyy-MM-dd'),
          calendarName: calName,
          recurring: ev.isRecurringEvent(),
          color: color
        });
      } else {
        events.push({
          title: ev.getTitle(),
          start: Utilities.formatDate(ev.getStartTime(), TZ, 'yyyy-MM-dd HH:mm'),
          end: Utilities.formatDate(ev.getEndTime(), TZ, 'yyyy-MM-dd HH:mm'),
          allDay: false,
          date: '',
          calendarName: calName,
          recurring: ev.isRecurringEvent(),
          color: color
        });
      }
    });
  });
  events.sort(function (a, b) {
    var ka = a.allDay ? a.date + ' 00:00' : a.start;
    var kb = b.allDay ? b.date + ' 00:00' : b.start;
    return ka === kb ? 0 : (ka < kb ? -1 : 1);
  });
  return events;
}

// Tasks高度なサービスが有効かどうか(未有効でも例外にしない)
function tasksAvailable_() {
  try {
    return typeof Tasks !== 'undefined' && !!Tasks.Tasklists;
  } catch (e) {
    return false;
  }
}

// 期限が[from, to)内の未完了タスクを {title, due, listName} で返す。未有効時は空配列。
function collectWeekTasks_(from, to) {
  if (!tasksAvailable_()) return [];
  var out = [];
  try {
    var dueMin = from + 'T00:00:00Z';
    var dueMax = to + 'T00:00:00Z';
    var taskLists = Tasks.Tasklists.list().items || [];
    taskLists.forEach(function (tl) {
      var items = Tasks.Tasks.list(tl.id, {
        showCompleted: false,
        dueMin: dueMin,
        dueMax: dueMax
      }).items || [];
      items.forEach(function (t) {
        if (!t.due || t.status === 'completed') return;
        var due = Utilities.formatDate(new Date(t.due), TZ, 'yyyy-MM-dd');
        if (due < from || due >= to) return; // API側のdueMin/dueMaxの念のための二重チェック
        out.push({ title: String(t.title || ''), due: due, listName: String(tl.title || '') });
      });
    });
  } catch (e) {
    console.error('タスク取得失敗: ' + e);
    return [];
  }
  return out;
}

function parseYmd_(s) {
  var p = s.split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

/* ===== 祝日API =====
   現行 GAS.txt の ensureHolidaysForYear_(597〜623行)のフィルタ仕様を踏襲するが、
   シートへのキャッシュはしない(呼ばれるたびに毎回取得。キャッシュはWorker側のD1が担う)。 */

// year年の祝日一覧を {holidays:[{date,name}]} で返す。
function getHolidays(year) {
  year = parseInt(year, 10);
  if (!year) throw new Error('不正な年指定: ' + year);
  var holidays = [];
  try {
    var cal = CalendarApp.getCalendarById(HOLIDAY_CALENDAR_ID);
    if (!cal) return { holidays: [] };
    var events = cal.getEvents(new Date(year, 0, 1), new Date(year + 1, 0, 1));
    // このカレンダーには「七夕」「大晦日」等の行事も含まれる。説明欄が「祝日」の
    // イベントだけを法定祝日として採用する(行事が混ざると営業日計算が狂う)。
    // 万一「祝日」表記が1件も無い場合(仕様変更)は、全件採用にフォールバック。
    var holidayEvents = events.filter(function (ev) {
      return String(ev.getDescription() || '').indexOf('祝日') >= 0;
    });
    if (!holidayEvents.length) holidayEvents = events;
    holidays = holidayEvents.map(function (ev) {
      return { date: Utilities.formatDate(ev.getStartTime(), TZ, 'yyyy-MM-dd'), name: ev.getTitle() };
    });
  } catch (e) {
    // 取得失敗でもアプリは動作継続(祝日なしを返す。呼び出し元のWorker/D1キャッシュ側で吸収)
    console.error('祝日取得失敗: ' + e);
    return { holidays: [] };
  }
  return { holidays: holidays };
}
