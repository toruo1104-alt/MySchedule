(function () {
  "use strict";

  /* ============================================================
     MySchedule — フロントロジック (app.js)

     配信: GitHub Pages(静的サイト)。データはGAS API経由でスプレッドシートへ。
     通信: fetch POST(Content-Type: text/plain で preflight 回避)
           {token, fn, args} → {ok, data | error}
     API設定: GAS WebアプリURL+トークンを初回に入力し localStorage に保存。
     モック: window.__MYSCHEDULE_MOCK__ があれば通信せずそちらを呼ぶ(preview/用)。

     状態管理:
       records: { "yyyy-MM-dd|HH:mm": {code, sub, memo} }  1スロット=30分
       days:    { "yyyy-MM-dd": {paidLeave, memo} }
     保存方式:
       楽観更新(UI即時反映) → デバウンス後に「月まるごと」をサーバーへ送信。
       保存中の追加変更は完了後に自動再送(直列化)。
     操作:
       パレットで区分(・内訳)/消しゴムを選択 → セルをクリック/矩形ドラッグで塗る
       セル右クリック → メモ編集 / 日ヘッダクリック → 有休・日メモ
  ============================================================ */

  /* ===== 定数 ===== */
  var SLOT_HOURS = 0.5;                       // 1スロット=30分
  var SAVE_DEBOUNCE_MS = 1200;                // 保存デバウンス
  var UNDO_LIMIT = 30;                        // 元に戻せる操作数
  var API_SETTINGS_KEY = "myschedule-api";    // localStorage キー
  var PALETTE_KEY = "myschedule-palette";     // パレット折りたたみ状態
  var VIEW_KEY = "myschedule-view";           // 表示中ビュー(月/週)の永続化キー
  var WEEK_PX_PER_HOUR = 48;                  // 週ビュー: 1時間あたりの高さ(px)
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  /* ===== 状態 ===== */
  var state = {
    ym: "",                                   // 表示中の年月 "yyyy-MM"
    config: { dayStart: "06:00", dayEnd: "22:00", ownHoursPerDay: 8, clientHoursPerDay: 7.5, clientWorkCode: "UB", manMonthRatio: 0.6 },
    categories: [],                           // 区分マスタ(表示順ソート済み)
    records: {},                              // スロット記録(キー: date|time)
    days: {},                                 // 日次情報(キー: date)
    holidays: {},                             // 祝日(キー: date, 値: 名称)
    tool: null,                               // {type:"paint", code, sub} | {type:"erase"}
    todayStr: "",                             // "yyyy-MM-dd"
    view: "month",                            // "month" | "week"
    weekStart: ""                             // 週ビューの週初め(月曜) "yyyy-MM-dd"
  };

  var catByCode = {};                         // code → 区分(親子とも)
  var apiSettings = null;                     // {url, token}
  var weekCache = new Map();                  // weekStart → listWeekData の返り値(セッション内メモリキャッシュ)
  var monthLoaded = false;                    // 月データを一度でも読み込み済みか(週→月切替時の再読込要否判定)

  /* 保存管理 */
  var saveTimer = null;
  var saving = false;
  var savePending = false;
  var dirtyRecords = false;
  var dirtyDays = false;

  /* ドラッグ塗り */
  var drag = null;                            // {anchorDate, anchorTime, curDate, curTime, erase}

  /* Undo履歴(操作直前のスナップショット。月を切り替えるとクリア) */
  var undoStack = [];

  /* ===== DOM 参照 ===== */
  var $grid = document.getElementById("grid");
  var $gridContainer = document.getElementById("grid-container");
  var $gridLoading = document.getElementById("grid-loading");
  var $summary = document.getElementById("summary");
  var $weekView = document.getElementById("week-view");
  var $weekLoading = document.getElementById("week-loading");
  var $weekGrid = document.getElementById("week-grid");
  var $weekTasksNote = document.getElementById("week-tasks-note");
  var $palette = document.getElementById("palette");
  var $ymLabel = document.getElementById("ym-label");
  var $saveStatus = document.getElementById("save-status");
  var $popover = document.getElementById("popover");
  var $modalOverlay = document.getElementById("modal-overlay");
  var $modal = document.getElementById("modal");
  var $toast = document.getElementById("toast");

  /* ===== 起動 ===== */
  init();

  function init() {
    var now = new Date();
    state.todayStr = ymdOf(now);
    state.ym = state.todayStr.substring(0, 7);
    loadApiSettings();

    document.getElementById("btn-prev").addEventListener("click", function () {
      if (state.view === "week") navWeek(-1); else navMonth(-1);
    });
    document.getElementById("btn-next").addEventListener("click", function () {
      if (state.view === "week") navWeek(+1); else navMonth(+1);
    });
    document.getElementById("btn-today").addEventListener("click", function () {
      if (state.view === "week") navWeekToday(); else navTo(state.todayStr.substring(0, 7));
    });
    document.getElementById("btn-categories").addEventListener("click", openCategoryModal);
    document.getElementById("btn-import").addEventListener("click", openImportModal);
    document.getElementById("btn-settings").addEventListener("click", openSettingsModal);
    document.getElementById("btn-undo").addEventListener("click", undo);
    document.getElementById("btn-toggle-palette").addEventListener("click", function () {
      setPaletteCollapsed(!$palette.classList.contains("is-collapsed"));
    });
    document.getElementById("btn-view-month").addEventListener("click", function () { switchView("month"); });
    document.getElementById("btn-view-week").addEventListener("click", function () { switchView("week"); });
    document.getElementById("btn-week-reload").addEventListener("click", function () {
      weekCache.delete(state.weekStart);
      loadWeek(state.weekStart);
    });
    initPaletteState();
    initViewState();
    $saveStatus.addEventListener("click", function () {
      if ($saveStatus.classList.contains("is-error")) flushSaveNow();
    });

    bindGridEvents();
    bindGlobalEvents();
    renderYmLabel();

    if (!hasApiAccess()) {
      openSettingsModal(); // 初回セットアップ
    } else if (state.view === "week") {
      loadWeek(state.weekStart);
    } else {
      loadMonth(state.ym);
    }
  }

  /* ===== ビュー切替(月/週) ===== */

  function initViewState() {
    var saved = localStorage.getItem(VIEW_KEY);
    state.view = saved === "week" ? "week" : "month";
    state.weekStart = mondayOf(state.todayStr);
    applyViewVisibility();
  }

  function switchView(view) {
    if (state.view === view) return;
    state.view = view;
    localStorage.setItem(VIEW_KEY, view);
    applyViewVisibility();
    renderYmLabel();
    if (view === "week") {
      loadWeek(state.weekStart); // hasApiAccess()の判定・設定モーダル誘導はloadWeek内で行う
    } else if (!monthLoaded) {
      loadMonth(state.ym); // 起動時に週ビューだったなどで月データが未読込のときだけ読み込む
    }
  }

  function applyViewVisibility() {
    var isWeek = state.view === "week";
    $gridContainer.hidden = isWeek;
    $summary.hidden = isWeek;
    $weekView.hidden = !isWeek;
    document.getElementById("btn-view-month").classList.toggle("is-active", !isWeek);
    document.getElementById("btn-view-week").classList.toggle("is-active", isWeek);
  }

  /* ===== パレットの折りたたみ(スマホで場所を取らないように) ===== */

  function initPaletteState() {
    var saved = localStorage.getItem(PALETTE_KEY);
    // 未設定なら画面幅で判断(狭い端末は畳んだ状態で開始)
    setPaletteCollapsed(saved === null ? window.innerWidth < 700 : saved === "collapsed");
  }

  function setPaletteCollapsed(collapsed) {
    $palette.classList.toggle("is-collapsed", collapsed);
    document.getElementById("btn-toggle-palette").classList.toggle("is-active", !collapsed);
    localStorage.setItem(PALETTE_KEY, collapsed ? "collapsed" : "open");
  }

  /* ===== Undo(操作直前のスナップショットを積む) ===== */

  // kind: "records" | "days" | "both" — undo時にどれを保存し直すかの判別に使う
  function pushUndo(kind) {
    var records = {};
    Object.keys(state.records).forEach(function (k) {
      var v = state.records[k];
      records[k] = { code: v.code, sub: v.sub, memo: v.memo };
    });
    var days = {};
    Object.keys(state.days).forEach(function (k) {
      var v = state.days[k];
      days[k] = { paidLeave: v.paidLeave, memo: v.memo };
    });
    undoStack.push({ records: records, days: days, kind: kind });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    updateUndoButton();
  }

  function undo() {
    if (!undoStack.length) return;
    var snap = undoStack.pop();
    state.records = snap.records;
    state.days = snap.days;
    if (snap.kind === "both") { markRecordsDirty(); markDaysDirty(); }
    else if (snap.kind === "days") markDaysDirty();
    else markRecordsDirty();
    updateUndoButton();
    closePopover();
    renderGrid();
    renderSummary();
    showToast("元に戻しました" + (undoStack.length ? "(あと" + undoStack.length + "回)" : ""), false);
  }

  function clearUndo() {
    undoStack = [];
    updateUndoButton();
  }

  function updateUndoButton() {
    var btn = document.getElementById("btn-undo");
    btn.disabled = undoStack.length === 0;
    btn.title = undoStack.length ? "元に戻す (Ctrl+Z) — あと" + undoStack.length + "回" : "元に戻す操作がありません";
  }

  /* ===== API設定(GAS URL+トークン) ===== */

  function hasApiAccess() {
    if (window.__MYSCHEDULE_MOCK__) return true;
    return !!(apiSettings && apiSettings.url && apiSettings.token);
  }

  function loadApiSettings() {
    try {
      apiSettings = JSON.parse(localStorage.getItem(API_SETTINGS_KEY) || "null");
    } catch (e) { apiSettings = null; }
  }

  function openSettingsModal() {
    var cur = apiSettings || { url: "", token: "" };
    $modal.innerHTML =
      "<h3>API設定" + (hasApiAccess() ? "" : "(初回セットアップ)") + "</h3>" +
      "<div class='modal-note'>README の手順で GAS をデプロイし、WebアプリURLと、" +
      "スプレッドシート「設定」シートの apiToken の値を貼り付けてください。" +
      "設定はこのブラウザにのみ保存されます。</div>" +
      "<div class='set-row'><label>GAS WebアプリURL</label>" +
      "<input type='text' id='set-url' placeholder='https://script.google.com/macros/s/…/exec' value='" + escapeAttr(cur.url) + "'></div>" +
      "<div class='set-row'><label>APIトークン(設定シートの apiToken)</label>" +
      "<input type='text' id='set-token' value='" + escapeAttr(cur.token) + "'></div>" +
      "<div class='modal-buttons'>" +
      "<button type='button' id='set-cancel'>閉じる</button>" +
      "<button type='button' id='set-save' class='primary'>保存して読み込み</button></div>";
    $modalOverlay.hidden = false;

    document.getElementById("set-cancel").addEventListener("click", closeModal);
    document.getElementById("set-save").addEventListener("click", function () {
      var url = document.getElementById("set-url").value.trim();
      var token = document.getElementById("set-token").value.trim();
      if (!url || !token) { showToast("URLとトークンの両方を入力してください", true); return; }
      apiSettings = { url: url, token: token };
      localStorage.setItem(API_SETTINGS_KEY, JSON.stringify(apiSettings));
      closeModal();
      loadMonth(state.ym);
    });
  }

  /* ===== サーバー通信 ===== */

  function serverCall(fnName) {
    var args = Array.prototype.slice.call(arguments, 1);
    // ローカルプレビュー(mock.js が定義)
    if (window.__MYSCHEDULE_MOCK__) {
      return window.__MYSCHEDULE_MOCK__.call(fnName, args);
    }
    if (!apiSettings || !apiSettings.url) {
      openSettingsModal();
      return Promise.reject(new Error("API設定が必要です(⚙から設定)"));
    }
    return fetch(apiSettings.url, {
      method: "POST",
      // text/plain にすることで CORS preflight を回避(GASの制約)
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: apiSettings.token, fn: fnName, args: args })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (res) {
      if (!res || res.ok !== true) {
        throw new Error(res && res.error ? res.error : "サーバーエラー");
      }
      return res.data;
    });
  }

  function handleServerError(err, contextMsg) {
    console.error(contextMsg, err);
    var msg = err && err.message ? err.message : String(err);
    showToast((contextMsg || "エラー") + ": " + msg, true);
    // 認証系のエラーは設定画面へ誘導
    if (/認証エラー|apiToken|API設定/.test(msg) && $modalOverlay.hidden) openSettingsModal();
  }

  /* ===== 月の読み込み・切替 ===== */

  function navMonth(delta) {
    var y = parseInt(state.ym.substring(0, 4), 10);
    var m = parseInt(state.ym.substring(5, 7), 10) + delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    navTo(y + "-" + pad2(m));
  }

  function navTo(ym) {
    if (ym === state.ym && $grid.rows.length) return;
    // 未保存分を先に送る。保存失敗が残っている場合は確認してから移動
    flushSaveNow().then(function () {
      if (dirtyRecords || dirtyDays) {
        if (!window.confirm("保存に失敗した変更があります。月を切り替えると失われますが、移動しますか?")) return;
        dirtyRecords = false; dirtyDays = false; setSaveStatus("saved");
      }
      loadMonth(ym);
    });
  }

  function loadMonth(ym) {
    if (!hasApiAccess()) { openSettingsModal(); return; }
    $gridLoading.hidden = false;
    serverCall("getMonthData", ym)
      .then(function (data) {
        state.ym = data.ym;
        state.config = data.config || state.config;
        state.categories = data.categories || [];
        rebuildCatIndex();
        state.records = {};
        (data.records || []).forEach(function (r) {
          state.records[r.date + "|" + r.time] = { code: r.code, sub: r.sub || "", memo: r.memo || "" };
        });
        state.days = {};
        (data.days || []).forEach(function (d) {
          state.days[d.date] = { paidLeave: !!d.paidLeave, memo: d.memo || "" };
        });
        state.holidays = data.holidays || {};
        clearUndo();   // 別の月の状態に戻せてしまうのを防ぐ
        ensureToolValid();
        monthLoaded = true;
        renderAll();
      })
      .catch(function (err) { handleServerError(err, "読み込みに失敗しました"); })
      .finally(function () { $gridLoading.hidden = true; });
  }

  function renderAll() {
    renderYmLabel();
    renderPalette();
    renderGrid();
    renderSummary();
  }

  /* ===== 区分マスタのインデックス・ツール ===== */

  function rebuildCatIndex() {
    catByCode = {};
    state.categories.forEach(function (c) { catByCode[c.code] = c; });
  }

  function activeParents() {
    return state.categories.filter(function (c) { return !c.parent && c.active; });
  }

  function activeChildrenOf(code) {
    return state.categories.filter(function (c) { return c.parent === code && c.active; });
  }

  function resolveColor(code, sub) {
    var c = sub ? catByCode[sub] : null;
    if (c && c.color) return c.color;
    c = catByCode[code];
    if (c && c.color) return c.color;
    if (c && c.parent && catByCode[c.parent] && catByCode[c.parent].color) return catByCode[c.parent].color;
    return "#eeeeee";
  }

  function catLabel(code) {
    return catByCode[code] ? catByCode[code].name : code;
  }

  // ツールが未選択・無効区分を指している場合、先頭の有効区分に戻す
  function ensureToolValid() {
    if (state.tool && state.tool.type === "erase") return;
    var ok = state.tool && state.tool.type === "paint" &&
      catByCode[state.tool.code] && catByCode[state.tool.code].active &&
      (!state.tool.sub || (catByCode[state.tool.sub] && catByCode[state.tool.sub].active));
    if (!ok) {
      var first = activeParents()[0];
      state.tool = first ? { type: "paint", code: first.code, sub: "" } : null;
    }
  }

  /* ===== パレット描画 ===== */

  function renderPalette() {
    $palette.innerHTML = "";
    activeParents().forEach(function (cat) {
      var children = activeChildrenOf(cat.code);
      var group = document.createElement("span");
      group.className = "pal-group";

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pal-btn";
      btn.dataset.code = cat.code;
      var selected = state.tool && state.tool.type === "paint" && state.tool.code === cat.code;
      if (selected) btn.classList.add("is-selected");
      btn.innerHTML =
        '<span class="pal-swatch" style="background:' + escapeHtml(cat.color || "#eee") + '"></span>' +
        escapeHtml(cat.code) + " " + escapeHtml(cat.name) +
        (children.length ? ' <span class="pal-sub-mark">▾</span>' : "") +
        (selected && state.tool.sub ? ' <span class="pal-sub-mark">(' + escapeHtml(catLabel(state.tool.sub)) + ")</span>" : "");
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (children.length) {
          toggleSubMenu(group, cat, children);
        } else {
          setTool({ type: "paint", code: cat.code, sub: "" });
        }
      });
      group.appendChild(btn);
      $palette.appendChild(group);
    });

    var eraser = document.createElement("button");
    eraser.type = "button";
    eraser.className = "pal-btn";
    if (state.tool && state.tool.type === "erase") eraser.classList.add("is-selected");
    eraser.innerHTML = "🧽 消しゴム";
    eraser.addEventListener("click", function () { setTool({ type: "erase" }); });
    $palette.appendChild(eraser);
  }

  function toggleSubMenu(group, cat, children) {
    var existing = group.querySelector(".pal-sub-menu");
    closeSubMenus();
    if (existing) return; // 開いていたものを閉じただけ

    var menu = document.createElement("div");
    menu.className = "pal-sub-menu";
    var items = [{ code: cat.code, sub: "", label: cat.name + "(全般)" }].concat(
      children.map(function (ch) { return { code: cat.code, sub: ch.code, label: ch.name }; })
    );
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pal-sub-item";
      var sel = state.tool && state.tool.type === "paint" &&
        state.tool.code === it.code && (state.tool.sub || "") === it.sub;
      if (sel) b.classList.add("is-selected");
      b.textContent = it.label;
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        setTool({ type: "paint", code: it.code, sub: it.sub });
      });
      menu.appendChild(b);
    });
    group.appendChild(menu);
  }

  function closeSubMenus() {
    var menus = $palette.querySelectorAll(".pal-sub-menu");
    for (var i = 0; i < menus.length; i++) menus[i].remove();
    return menus.length > 0;
  }

  function setTool(tool) {
    state.tool = tool;
    closeSubMenus();
    renderPalette();
  }

  /* ===== グリッド描画 ===== */

  function renderYmLabel() {
    if (state.view === "week") {
      $ymLabel.textContent = weekLabel(state.weekStart);
    } else {
      $ymLabel.textContent = parseInt(state.ym.substring(0, 4), 10) + "年" +
        parseInt(state.ym.substring(5, 7), 10) + "月";
    }
  }

  function timeSlots() {
    var out = [];
    var start = timeToMin(state.config.dayStart);
    var end = timeToMin(state.config.dayEnd);
    for (var t = start; t < end; t += 30) out.push(minToTime(t));
    return out;
  }

  function monthDates() {
    var y = parseInt(state.ym.substring(0, 4), 10);
    var m = parseInt(state.ym.substring(5, 7), 10);
    var days = new Date(y, m, 0).getDate();
    var out = [];
    for (var d = 1; d <= days; d++) {
      var dateStr = state.ym + "-" + pad2(d);
      out.push({ date: dateStr, day: d, dow: new Date(y, m - 1, d).getDay() });
    }
    return out;
  }

  // 指定区分の日ごとの合計時間 { "yyyy-MM-dd": 時間 }
  function dailyTotals(code) {
    var map = {};
    Object.keys(state.records).forEach(function (key) {
      if (state.records[key].code !== code) return;
      var date = key.substring(0, 10);
      map[date] = (map[date] || 0) + SLOT_HOURS;
    });
    return map;
  }

  // 日の状態クラス(土/日祝/有休)。セル・ヘッダ共通。
  // holidaysMap省略時はstate.holidays(月ビュー用)を使う。週ビューはその週データのholidaysを明示的に渡す
  // (週ビューには有休の概念が無いため skipPaidLeave=true で有休判定を無効化する)
  function dayClass(d, holidaysMap, skipPaidLeave) {
    var holidays = holidaysMap || state.holidays;
    var info = state.days[d.date];
    if (!skipPaidLeave && info && info.paidLeave) return "day-paidleave";
    if (holidays[d.date]) return "day-holiday";
    if (d.dow === 0) return "day-sun";
    if (d.dow === 6) return "day-sat";
    return "";
  }

  function renderGrid() {
    var dates = monthDates();
    var slots = timeSlots();
    var html = [];

    // ---- ヘッダ(日付・曜日・祝日/有休/日メモ) ----
    html.push("<thead><tr><th class='col-time'>時間</th>");
    dates.forEach(function (d) {
      var cls = dayClass(d);
      if (d.date === state.todayStr) cls += " is-today";
      var info = state.days[d.date] || {};
      var mark = "";
      if (state.holidays[d.date]) mark = state.holidays[d.date];
      if (info.paidLeave) mark = "有休";
      if (info.memo) mark = (mark ? mark + "・" : "") + info.memo;
      html.push("<th class='" + cls + "' data-date='" + d.date + "' title='クリックで有休・日メモを編集'>" +
        "<span class='dh-day'>" + d.day + "</span>" +
        "<span class='dh-wd'>" + WEEKDAYS[d.dow] + "</span>" +
        (mark ? "<span class='dh-mark'>" + escapeHtml(truncate(mark, 5)) + "</span>" : "") +
        "</th>");
    });
    html.push("<th class='col-time'>時間</th></tr></thead>");

    // ---- ボディ(30分×時間帯) ----
    html.push("<tbody>");
    slots.forEach(function (time) {
      var isHour = time.substring(3) === "00";
      var label = isHour ? String(parseInt(time.substring(0, 2), 10)) + ":00" : "";
      html.push("<tr" + (isHour ? " class='hour-start'" : "") + ">");
      html.push("<th class='col-time'>" + label + "</th>");
      dates.forEach(function (d) {
        var key = d.date + "|" + time;
        var rec = state.records[key];
        var cls = "slot " + dayClass(d);
        if (d.date === state.todayStr) cls += " is-today";
        var style = "";
        var text = "";
        var title = formatDateJp(d.date) + " " + time;
        if (rec) {
          style = " style='background:" + escapeHtml(resolveColor(rec.code, rec.sub)) + "'";
          var dispName = rec.memo || (rec.sub ? catLabel(rec.sub) : rec.code);
          text = rec.memo ? "<span class='memo-text'>" + escapeHtml(truncate(rec.memo, 4)) + "</span>"
                          : escapeHtml(truncate(dispName, 4));
          if (rec.memo) cls += " has-memo";
          title += " " + catLabel(rec.code) + (rec.sub ? "/" + catLabel(rec.sub) : "") +
            (rec.memo ? "「" + rec.memo + "」" : "");
        }
        html.push("<td class='" + cls + "' data-date='" + d.date + "' data-time='" + time + "'" +
          style + " title='" + escapeHtml(title) + "'>" + text + "</td>");
      });
      html.push("<th class='col-time'>" + label + "</th>");
      html.push("</tr>");
    });
    html.push("</tbody>");

    // ---- 日ごとの合計(派遣先業務。最下部に固定表示) ----
    var sumCode = state.config.clientWorkCode || "UB";
    var totals = dailyTotals(sumCode);
    html.push("<tfoot><tr>");
    html.push("<th class='col-time'>" + escapeHtml(sumCode) + "計</th>");
    dates.forEach(function (d) {
      var h = totals[d.date] || 0;
      html.push("<td class='" + (h ? "" : "is-zero") + "' title='" + formatDateJp(d.date) + " " +
        escapeHtml(sumCode) + " 合計'>" + fmtNum(h) + "</td>");
    });
    html.push("<th class='col-time'>" + escapeHtml(sumCode) + "計</th>");
    html.push("</tr></tfoot>");

    $grid.innerHTML = html.join("");
  }

  /* ===== 塗り操作(クリック・矩形ドラッグ) ===== */

  function bindGridEvents() {
    $grid.addEventListener("mousedown", function (ev) {
      if (ev.button !== 0) return;
      var td = ev.target.closest("td.slot");
      if (!td || !state.tool) return;
      ev.preventDefault();
      drag = {
        anchorDate: td.dataset.date, anchorTime: td.dataset.time,
        curDate: td.dataset.date, curTime: td.dataset.time,
        // 消しゴム選択中、または「選択中の区分と同じセル」から始めた場合は消去
        // (同じ区分をなぞれば消える。別区分ならそのまま上書きできる)
        erase: state.tool.type === "erase" || isSameAsTool(state.records[td.dataset.date + "|" + td.dataset.time])
      };
      updateDragPreview();
    });

    $grid.addEventListener("mouseover", function (ev) {
      if (!drag) return;
      var td = ev.target.closest("td.slot");
      if (!td) return;
      drag.curDate = td.dataset.date;
      drag.curTime = td.dataset.time;
      updateDragPreview();
    });

    document.addEventListener("mouseup", function () {
      if (!drag) return;
      applyToolToRect(drag);
      drag = null;
      updateDragPreview();
    });

    // 日ヘッダ → 有休・日メモ
    $grid.addEventListener("click", function (ev) {
      var th = ev.target.closest("thead th[data-date]");
      if (th) openDayPopover(th, th.dataset.date);
    });

    // セル右クリック → メモ編集
    $grid.addEventListener("contextmenu", function (ev) {
      var td = ev.target.closest("td.slot");
      if (!td) return;
      ev.preventDefault();
      openMemoPopover(td, td.dataset.date, td.dataset.time);
    });

    // グリッドスクロールでポップオーバーの位置が狂うため閉じる
    $gridContainer.addEventListener("scroll", closePopover);
  }

  function rectKeys(dragInfo) {
    var d1 = dragInfo.anchorDate, d2 = dragInfo.curDate;
    if (d1 > d2) { var tmp = d1; d1 = d2; d2 = tmp; }
    var t1 = dragInfo.anchorTime, t2 = dragInfo.curTime;
    if (t1 > t2) { var tm = t1; t1 = t2; t2 = tm; }
    var keys = [];
    monthDates().forEach(function (d) {
      if (d.date < d1 || d.date > d2) return;
      timeSlots().forEach(function (time) {
        if (time < t1 || time > t2) return;
        keys.push(d.date + "|" + time);
      });
    });
    return keys;
  }

  // 選択中のツールと同じ区分・内訳のスロットか(なぞって消す判定に使う)
  function isSameAsTool(rec) {
    return !!(rec && state.tool && state.tool.type === "paint" &&
      rec.code === state.tool.code && (rec.sub || "") === (state.tool.sub || ""));
  }

  function updateDragPreview() {
    var marked = $grid.querySelectorAll("td.is-drag, td.is-drag-erase");
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove("is-drag", "is-drag-erase");
    if (!drag) return;
    var cls = drag.erase ? "is-drag-erase" : "is-drag";
    var keys = {};
    rectKeys(drag).forEach(function (k) { keys[k] = true; });
    var tds = $grid.querySelectorAll("td.slot");
    for (var j = 0; j < tds.length; j++) {
      var td = tds[j];
      if (keys[td.dataset.date + "|" + td.dataset.time]) td.classList.add(cls);
    }
  }

  function applyToolToRect(dragInfo) {
    var keys = rectKeys(dragInfo);
    if (!keys.length || !state.tool) return;
    // 実際に変わるものが無ければ何もしない(無駄な履歴と保存を防ぐ)
    var changed = keys.some(function (key) {
      var rec = state.records[key];
      if (dragInfo.erase) return !!rec;
      return !rec || rec.code !== state.tool.code ||
        (rec.sub || "") !== (state.tool.sub || "") || !!rec.memo;
    });
    if (!changed) return;
    pushUndo("records");
    keys.forEach(function (key) {
      if (dragInfo.erase) {
        delete state.records[key];
      } else {
        // 塗り直しでメモは引き継がない(区分とメモの食い違いを防ぐ)
        state.records[key] = { code: state.tool.code, sub: state.tool.sub || "", memo: "" };
      }
    });
    markRecordsDirty();
    renderGrid();
    renderSummary();
  }

  /* ===== セルメモのポップオーバー ===== */

  function openMemoPopover(td, date, time) {
    var key = date + "|" + time;
    var rec = state.records[key];
    if (!rec) { showToast("メモは区分を塗ったスロットに付けられます", false); return; }

    var block = contiguousSameSlots(date, time);
    openPopover(td,
      "<h4>" + formatDateJp(date) + " " + time + " — " + escapeHtml(catLabel(rec.code)) +
      (rec.sub ? "/" + escapeHtml(catLabel(rec.sub)) : "") + "</h4>" +
      "<div class='pop-row'><input type='text' id='memo-input' placeholder='メモ(例: 浜北、char、PSS)' value='" +
        escapeAttr(rec.memo) + "'></div>" +
      "<div class='pop-row'><label><input type='checkbox' id='memo-apply-block' checked> 同じ区分が連続する " +
        block.length + " 枠(" + block[0].split("|")[1] + "〜)にまとめて適用</label></div>" +
      "<div class='pop-buttons'>" +
        "<button type='button' id='memo-cancel'>キャンセル</button>" +
        "<button type='button' id='memo-save' class='primary'>適用</button></div>");

    var input = document.getElementById("memo-input");
    input.focus();
    input.select();
    var save = function () {
      var memo = input.value.trim();
      var applyBlock = document.getElementById("memo-apply-block").checked;
      var targets = applyBlock ? block : [key];
      if (!targets.some(function (k) { return state.records[k] && state.records[k].memo !== memo; })) {
        closePopover();
        return;
      }
      pushUndo("records");
      targets.forEach(function (k) {
        if (state.records[k]) state.records[k].memo = memo;
      });
      markRecordsDirty();
      closePopover();
      renderGrid();
    };
    document.getElementById("memo-save").addEventListener("click", save);
    input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") save(); });
    document.getElementById("memo-cancel").addEventListener("click", closePopover);
  }

  // 同じ日付内で、同一の区分・内訳が連続するスロットキー群(時刻順)
  function contiguousSameSlots(date, time) {
    var slots = timeSlots();
    var idx = slots.indexOf(time);
    var base = state.records[date + "|" + time];
    if (!base || idx < 0) return [date + "|" + time];
    var same = function (i) {
      var r = state.records[date + "|" + slots[i]];
      return r && r.code === base.code && (r.sub || "") === (base.sub || "");
    };
    var s = idx, e = idx;
    while (s - 1 >= 0 && same(s - 1)) s--;
    while (e + 1 < slots.length && same(e + 1)) e++;
    var keys = [];
    for (var i = s; i <= e; i++) keys.push(date + "|" + slots[i]);
    return keys;
  }

  /* ===== 日情報(有休・日メモ)のポップオーバー ===== */

  function openDayPopover(th, date) {
    var info = state.days[date] || { paidLeave: false, memo: "" };
    openPopover(th,
      "<h4>" + formatDateJp(date) +
      (state.holidays[date] ? " <span class='pop-note'>(" + escapeHtml(state.holidays[date]) + ")</span>" : "") + "</h4>" +
      "<div class='pop-row'><label><input type='checkbox' id='day-paidleave'" +
        (info.paidLeave ? " checked" : "") + "> 有休</label></div>" +
      "<div class='pop-row'><input type='text' id='day-memo' placeholder='日メモ(例: 歓迎会、訪問)' value='" +
        escapeAttr(info.memo) + "'></div>" +
      "<div class='pop-buttons'>" +
        "<button type='button' id='day-cancel'>キャンセル</button>" +
        "<button type='button' id='day-save' class='primary'>適用</button></div>");

    var save = function () {
      var paidLeave = document.getElementById("day-paidleave").checked;
      var memo = document.getElementById("day-memo").value.trim();
      var cur = state.days[date] || { paidLeave: false, memo: "" };
      if (cur.paidLeave === paidLeave && cur.memo === memo) {
        closePopover();
        return;
      }
      pushUndo("days");
      if (paidLeave || memo) {
        state.days[date] = { paidLeave: paidLeave, memo: memo };
      } else {
        delete state.days[date];
      }
      markDaysDirty();
      closePopover();
      renderGrid();
      renderSummary();
    };
    document.getElementById("day-save").addEventListener("click", save);
    document.getElementById("day-memo").addEventListener("keydown", function (ev) { if (ev.key === "Enter") save(); });
    document.getElementById("day-cancel").addEventListener("click", closePopover);
  }

  /* ===== ポップオーバー共通 ===== */

  function openPopover(anchorEl, innerHtml) {
    closePopover();
    $popover.innerHTML = innerHtml;
    $popover.hidden = false;
    var rect = anchorEl.getBoundingClientRect();
    var top = rect.bottom + window.scrollY + 4;
    var left = rect.left + window.scrollX;
    // 画面右端からはみ出す場合は左へ寄せる
    var w = $popover.offsetWidth || 240;
    if (left + w > window.scrollX + document.documentElement.clientWidth - 8) {
      left = window.scrollX + document.documentElement.clientWidth - w - 8;
    }
    $popover.style.top = top + "px";
    $popover.style.left = Math.max(left, 4) + "px";
  }

  function closePopover() {
    if ($popover.hidden) return false;
    $popover.hidden = true;
    $popover.innerHTML = "";
    return true;
  }

  /* ===== 区分マスタ編集モーダル ===== */

  function openCategoryModal() {
    var rows = state.categories.map(function (c, i) { return categoryRowHtml(c, i); }).join("");
    $modal.innerHTML =
      "<h3>区分の編集</h3>" +
      "<div class='modal-note'>コードは追加後は変更できません(名称・色などは変更可)。" +
      "不要になった区分は「有効」を外すとパレットに出なくなります(過去の記録はそのまま残ります)。<br>" +
      "内訳にしたい場合は「親コード」に親の区分コードを入れてください。色が空欄の内訳は親の色で表示されます。</div>" +
      "<table class='cat-table'><thead><tr>" +
      "<th>コード</th><th>名称</th><th>親コード</th><th>色</th><th>表示順</th><th>有効</th>" +
      "</tr></thead><tbody id='cat-tbody'>" + rows + "</tbody></table>" +
      "<div class='modal-buttons'>" +
      "<button type='button' id='cat-add'>+ 行を追加</button>" +
      "<button type='button' id='cat-cancel'>キャンセル</button>" +
      "<button type='button' id='cat-save' class='primary'>保存</button></div>";
    $modalOverlay.hidden = false;

    document.getElementById("cat-add").addEventListener("click", function () {
      var tbody = document.getElementById("cat-tbody");
      var maxOrder = 0;
      state.categories.forEach(function (c) { maxOrder = Math.max(maxOrder, c.order); });
      var tr = document.createElement("tr");
      tr.innerHTML = categoryRowHtml({ code: "", name: "", parent: "", color: "#cccccc", order: maxOrder + 10, active: true }, -1)
        .replace(/^<tr>|<\/tr>$/g, "");
      tbody.appendChild(tr);
    });
    document.getElementById("cat-cancel").addEventListener("click", closeModal);
    document.getElementById("cat-save").addEventListener("click", saveCategoryModal);
  }

  function categoryRowHtml(c, idx) {
    var isNew = idx < 0;
    return "<tr>" +
      "<td>" + (isNew
        ? "<input type='text' class='cat-code' value=''>"
        : "<span class='cat-fixed'>" + escapeHtml(c.code) + "</span><input type='hidden' class='cat-code' value='" + escapeAttr(c.code) + "'>") + "</td>" +
      "<td><input type='text' class='cat-name' value='" + escapeAttr(c.name) + "'></td>" +
      "<td><input type='text' class='cat-parent' value='" + escapeAttr(c.parent) + "'></td>" +
      "<td><input type='color' class='cat-color' value='" + escapeAttr(normalizeColor(c.color)) + "'>" +
        (c.color ? "" : " <label style='font-size:10px'><input type='checkbox' class='cat-color-inherit' checked>親の色</label>") + "</td>" +
      "<td><input type='text' class='cat-order' value='" + escapeAttr(String(c.order)) + "'></td>" +
      "<td style='text-align:center'><input type='checkbox' class='cat-active'" + (c.active ? " checked" : "") + "></td>" +
      "</tr>";
  }

  function saveCategoryModal() {
    var trs = document.querySelectorAll("#cat-tbody tr");
    var list = [];
    var seen = {};
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var code = tr.querySelector(".cat-code").value.trim();
      if (!code) continue; // コード未入力の行は無視
      if (seen[code]) { showToast("コードが重複しています: " + code, true); return; }
      seen[code] = true;
      var inheritCb = tr.querySelector(".cat-color-inherit");
      list.push({
        code: code,
        name: tr.querySelector(".cat-name").value.trim(),
        parent: tr.querySelector(".cat-parent").value.trim(),
        color: (inheritCb && inheritCb.checked) ? "" : tr.querySelector(".cat-color").value,
        order: parseFloat(tr.querySelector(".cat-order").value) || 0,
        active: tr.querySelector(".cat-active").checked
      });
    }
    // 親コードの存在チェック
    for (var j = 0; j < list.length; j++) {
      if (list[j].parent && !seen[list[j].parent]) {
        showToast("親コード「" + list[j].parent + "」が見つかりません(" + list[j].code + ")", true);
        return;
      }
    }
    list.sort(function (a, b) { return a.order - b.order; });

    setSaveStatus("saving");
    serverCall("saveCategories", list)
      .then(function () {
        state.categories = list;
        rebuildCatIndex();
        ensureToolValid();
        closeModal();
        renderAll();
        setSaveStatus("saved");
        showToast("区分を保存しました", false);
      })
      .catch(function (err) {
        setSaveStatus("error");
        handleServerError(err, "区分の保存に失敗しました");
      });
  }

  function closeModal() {
    if ($modalOverlay.hidden) return false;
    $modalOverlay.hidden = true;
    $modal.innerHTML = "";
    return true;
  }

  /* ===== カレンダー取込モーダル(フェーズ3) ===== */

  // {events: [{title,start,end,allDay,date,calendarName}], importMap: {タイトル:{code,sub}}}
  var importState = { events: [], importMap: {} };

  function openImportModal() {
    $modal.innerHTML = importNoteHtml() + "<div class='modal-note'>読み込み中…</div>";
    $modalOverlay.hidden = false;

    serverCall("listCalendarEvents", state.ym)
      .then(function (data) {
        importState.events = data.events || [];
        importState.importMap = data.importMap || {};
        renderImportTable();
      })
      .catch(function (err) {
        closeModal();
        handleServerError(err, "カレンダー予定の取得に失敗しました");
      });
  }

  function importNoteHtml() {
    return "<h3>Googleカレンダー取込 — " + escapeHtml($ymLabel.textContent) + "</h3>" +
      "<div class='modal-note'>取り込みたい予定にチェックを入れて「取込実行」を押してください。" +
      "終日の予定は日メモとして取り込まれます(ゴミの日などはチェックしなければ無視されます)。" +
      "一度取り込んだタイトルは区分を記憶し、次回から自動でチェック・選択されます。</div>";
  }

  function renderImportTable() {
    var body = importState.events.length
      ? "<table class='imp-table'><thead><tr><th></th><th>日時</th><th>タイトル</th><th>割当</th><th>状態</th></tr></thead>" +
        "<tbody id='imp-tbody'>" + importState.events.map(importRowHtml).join("") + "</tbody></table>"
      : "<div class='modal-note'>今月のカレンダー予定は見つかりませんでした。</div>";
    $modal.innerHTML = importNoteHtml() + body +
      "<div class='modal-buttons'>" +
      "<span id='imp-count' class='imp-count'></span>" +
      "<button type='button' id='imp-cancel'>キャンセル</button>" +
      "<button type='button' id='imp-exec' class='primary'>取込実行</button></div>";

    document.getElementById("imp-cancel").addEventListener("click", closeModal);
    document.getElementById("imp-exec").addEventListener("click", executeImport);
    var checks = $modal.querySelectorAll(".imp-check");
    for (var i = 0; i < checks.length; i++) checks[i].addEventListener("change", updateImportCount);
    updateImportCount();
  }

  // タイトルから区分を引く。完全一致(過去に取り込んだ実績)を優先し、無ければ
  // 部分一致(「UB定例」に「UB」ルールが当たる)。複数当たればキーワードが長い=具体的な方を採る
  function lookupImportRule(title) {
    var map = importState.importMap;
    if (map[title]) return { code: map[title].code, sub: map[title].sub || "", exact: true };
    var best = null;
    Object.keys(map).forEach(function (key) {
      if (!key || title.indexOf(key) < 0) return;
      if (!best || key.length > best.key.length) {
        best = { key: key, code: map[key].code, sub: map[key].sub || "" };
      }
    });
    return best ? { code: best.code, sub: best.sub, exact: false } : null;
  }

  function importRowHtml(ev, idx) {
    var rule = lookupImportRule(ev.title);
    var assignHtml, checked;
    if (ev.allDay) {
      assignHtml = "<span class='imp-fixed'>日メモとして取込</span>";
      checked = !!rule;
    } else {
      // 終日用の記憶(DAYMEMO)は時間付きイベントには使えない(区分が決まらない)
      var usable = rule && rule.code && rule.code !== "DAYMEMO";
      var selValue = usable ? (rule.sub ? rule.code + "|" + rule.sub : rule.code) : "";
      assignHtml = importCategorySelectHtml(selValue);
      if (usable && !rule.exact) assignHtml += " <span class='imp-guess'>推定</span>";
      checked = !!usable;
    }
    return "<tr data-idx='" + idx + "'>" +
      "<td><input type='checkbox' class='imp-check'" + (checked ? " checked" : "") + "></td>" +
      "<td class='imp-when'>" + escapeHtml(importDateTimeLabel(ev)) + "</td>" +
      "<td>" + escapeHtml(ev.title) + (ev.calendarName ? " <span class='imp-cal'>(" + escapeHtml(ev.calendarName) + ")</span>" : "") + "</td>" +
      "<td>" + assignHtml + "</td>" +
      "<td>" + importStatusHtml(ev) + "</td>" +
      "</tr>";
  }

  // 有効な大区分をoptgroup、内訳を子optionにしたセレクト。値は "CODE" または "CODE|SUB"
  function importCategorySelectHtml(selValue) {
    var html = "<select class='imp-cat-select'><option value=''>(区分を選択)</option>";
    activeParents().forEach(function (cat) {
      var children = activeChildrenOf(cat.code);
      var parentOpt = "<option value='" + escapeAttr(cat.code) + "'" +
        (selValue === cat.code ? " selected" : "") + ">" + escapeHtml(cat.code + " " + cat.name) +
        (children.length ? "(全般)" : "") + "</option>";
      if (!children.length) { html += parentOpt; return; }
      html += "<optgroup label='" + escapeHtml(cat.code + " " + cat.name) + "'>" + parentOpt;
      children.forEach(function (ch) {
        var val = cat.code + "|" + ch.code;
        html += "<option value='" + escapeAttr(val) + "'" + (selValue === val ? " selected" : "") + ">" +
          escapeHtml(ch.name) + "</option>";
      });
      html += "</optgroup>";
    });
    html += "</select>";
    return html;
  }

  function importDateTimeLabel(ev) {
    if (ev.allDay) return formatDateJp(ev.date) + " 終日";
    var date = ev.start.substring(0, 10);
    return formatDateJp(date) + " " + ev.start.substring(11) + "-" + ev.end.substring(11);
  }

  function importStatusHtml(ev) {
    if (ev.allDay) return "";
    var marks = [];
    var slots = importTimedSlots(ev);
    if (slots.times.some(function (t) { return !!state.records[slots.date + "|" + t]; })) {
      marks.push("<span class='imp-overwrite'>上書き</span>");
    }
    var dayStart = timeToMin(state.config.dayStart), dayEnd = timeToMin(state.config.dayEnd);
    if (slots.times.some(function (t) { var m = timeToMin(t); return m < dayStart || m >= dayEnd; })) {
      marks.push("<span class='imp-outside'>⚠時間帯外含む</span>");
    }
    return marks.join(" ");
  }

  // 時間付きイベント→30分丸めのスロット時刻群(開始=切り下げ/終了=切り上げ/日またぎは開始日23:59で打ち切り)
  function importTimedSlots(ev) {
    var date = ev.start.substring(0, 10);
    var startMin = timeToMin(ev.start.substring(11));
    var endMin = ev.end.substring(0, 10) !== date ? 24 * 60 : timeToMin(ev.end.substring(11));
    var s = Math.floor(startMin / 30) * 30;
    var e = Math.min(Math.ceil(endMin / 30) * 30, 24 * 60);
    if (e <= s) e = s + 30; // 0分イベントでも最低1スロット
    var times = [];
    for (var t = s; t < e; t += 30) times.push(minToTime(t));
    return { date: date, times: times };
  }

  function updateImportCount() {
    var n = $modal.querySelectorAll(".imp-check:checked").length;
    var el = document.getElementById("imp-count");
    if (el) el.textContent = n + "件選択中";
  }

  function executeImport() {
    var trs = document.querySelectorAll("#imp-tbody tr");
    var picked = [];
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      if (!tr.querySelector(".imp-check").checked) continue;
      var ev = importState.events[parseInt(tr.dataset.idx, 10)];
      var entry = { event: ev, code: "", sub: "" };
      if (!ev.allDay) {
        var sel = tr.querySelector(".imp-cat-select").value;
        if (!sel) { showToast("区分未選択の行があります(「" + ev.title + "」)", true); return; }
        var parts = sel.split("|");
        entry.code = parts[0];
        entry.sub = parts[1] || "";
      }
      picked.push(entry);
    }
    if (!picked.length) { showToast("取り込む予定にチェックを入れてください", false); return; }

    pushUndo("both");
    var recordsChanged = false, daysChanged = false;
    picked.forEach(function (entry) {
      var ev = entry.event;
      if (ev.allDay) {
        var info = state.days[ev.date] || { paidLeave: false, memo: "" };
        var parts = info.memo ? info.memo.split("・") : [];
        if (parts.indexOf(ev.title) < 0) {
          parts.push(ev.title);
          state.days[ev.date] = { paidLeave: info.paidLeave, memo: parts.join("・") };
          daysChanged = true;
        }
      } else {
        var slots = importTimedSlots(ev);
        slots.times.forEach(function (t) {
          state.records[slots.date + "|" + t] = { code: entry.code, sub: entry.sub, memo: "" };
        });
        recordsChanged = true;
      }
    });
    if (recordsChanged) markRecordsDirty();
    if (daysChanged) markDaysDirty();

    // 提案どおりに取り込んだものは記憶を増やさない(既存ルールで足りるため。
    // ルールと違う区分を選んだ場合だけ、そのタイトルを完全一致で覚える)
    var mapEntries = picked.filter(function (entry) {
      var rule = lookupImportRule(entry.event.title);
      if (!rule) return true;
      return entry.event.allDay ? rule.code !== "DAYMEMO"
        : !(rule.code === entry.code && rule.sub === entry.sub);
    }).map(function (entry) {
      return entry.event.allDay
        ? { title: entry.event.title, code: "DAYMEMO", sub: "" }
        : { title: entry.event.title, code: entry.code, sub: entry.sub };
    });
    // 記憶の保存は失敗しても取込自体は成立させる(トーストのみで通知)
    if (mapEntries.length) {
      serverCall("saveImportMap", mapEntries).catch(function (err) {
        handleServerError(err, "取込対応の記憶保存に失敗しました(取込自体は反映済みです)");
      });
    }

    closeModal();
    renderGrid();
    renderSummary();
    showToast(picked.length + "件取り込みました", false);
  }

  /* ===== 集計 ===== */

  function renderSummary() {
    var dates = monthDates();

    // --- 区分別集計(親=直塗り+内訳合算) ---
    var byCode = {};   // 親・子コードそれぞれの時間
    var total = 0;
    Object.keys(state.records).forEach(function (key) {
      var rec = state.records[key];
      byCode[rec.code] = (byCode[rec.code] || 0) + SLOT_HOURS;
      if (rec.sub) byCode["sub:" + rec.sub] = (byCode["sub:" + rec.sub] || 0) + SLOT_HOURS;
      total += SLOT_HOURS;
    });

    var rowsHtml = "";
    var parents = state.categories.filter(function (c) { return !c.parent; });
    parents.forEach(function (cat) {
      var children = state.categories.filter(function (c) { return c.parent === cat.code; });
      var subTotal = byCode[cat.code] || 0;
      if (!subTotal && !children.some(function (ch) { return byCode["sub:" + ch.code]; })) return;
      var pct = total ? Math.round(subTotal / total * 100) : 0;
      rowsHtml += "<tr><th><span class='sum-swatch' style='background:" + escapeHtml(cat.color || "#eee") + "'></span>" +
        escapeHtml(cat.code) + " " + escapeHtml(cat.name) + "</th>" +
        "<td>" + fmtHours(subTotal) + "</td><td>" + pct + "%</td></tr>";
      children.forEach(function (ch) {
        var h = byCode["sub:" + ch.code] || 0;
        if (!h) return;
        rowsHtml += "<tr class='sum-sub'><th>" + escapeHtml(ch.name) + "</th>" +
          "<td>" + fmtHours(h) + "</td><td></td></tr>";
      });
    });
    rowsHtml += "<tr class='sum-total'><th>合計</th><td>" + fmtHours(total) + "</td><td>" + (total ? "100%" : "") + "</td></tr>";

    document.getElementById("summary-categories").innerHTML =
      "<h3>月間集計(区分別)</h3><table class='sum-table'>" + rowsHtml + "</table>";

    // --- 勤務日数・要求時間 ---
    var bizDays = 0, paidLeaves = 0;
    dates.forEach(function (d) {
      var isBiz = d.dow >= 1 && d.dow <= 5 && !state.holidays[d.date];
      if (!isBiz) return;
      bizDays++;
      var info = state.days[d.date];
      if (info && info.paidLeave) paidLeaves++;
    });
    var workDays = bizDays - paidLeaves;
    var ratio = state.config.manMonthRatio || 1;   // 契約人月(0.6人月契約 → 要求時間×0.6)
    var ownReq = workDays * state.config.ownHoursPerDay * ratio;
    var clientReq = workDays * state.config.clientHoursPerDay * ratio;
    var ubActual = byCode[state.config.clientWorkCode] || 0;
    var diffClient = ubActual - clientReq;
    var diffOwn = ubActual - ownReq;
    var ratioLabel = ratio === 1 ? "" : "×" + ratio;

    document.getElementById("summary-work").innerHTML =
      "<h3>勤務日数・要求時間</h3><table class='sum-table'>" +
      "<tr><th>営業日(平日−祝日)</th><td>" + bizDays + "日</td><td></td></tr>" +
      "<tr><th>有休</th><td>" + paidLeaves + "日</td><td></td></tr>" +
      "<tr class='sum-total'><th>勤務日数</th><td>" + workDays + "日</td><td></td></tr>" +
      "<tr><th>" + escapeHtml(state.config.clientWorkCode) + " 実績</th><td>" + fmtHours(ubActual) + "</td><td></td></tr>" +
      "<tr><th>派遣先要求(×" + state.config.clientHoursPerDay + "h" + ratioLabel + ")</th><td>" + fmtHours(clientReq) + "</td>" +
        "<td class='" + diffCls(diffClient) + "'>" + fmtDiff(diffClient) + "</td></tr>" +
      "<tr><th>自社要求(×" + state.config.ownHoursPerDay + "h" + ratioLabel + ")</th><td>" + fmtHours(ownReq) + "</td>" +
        "<td class='" + diffCls(diffOwn) + "'>" + fmtDiff(diffOwn) + "</td></tr>" +
      "</table>";
  }

  function diffCls(v) { return v >= 0 ? "sum-diff-plus" : "sum-diff-minus"; }
  function fmtDiff(v) { return (v >= 0 ? "+" : "") + fmtHours(v); }
  function fmtHours(h) { return fmtNum(h) + "h"; }
  function fmtNum(h) {
    var r = Math.round(h * 10) / 10;
    return r % 1 === 0 ? String(r) : r.toFixed(1);
  }

  /* ===== 週ビュー(読み取り専用) ===== */

  // 日付文字列("yyyy-MM-dd")→ Date型は描画時の一時計算にのみ使い、状態には持たない
  function parseDateStr(dateStr) {
    return new Date(parseInt(dateStr.substring(0, 4), 10),
      parseInt(dateStr.substring(5, 7), 10) - 1, parseInt(dateStr.substring(8, 10), 10));
  }

  function addDaysStr(dateStr, n) {
    var d = parseDateStr(dateStr);
    d.setDate(d.getDate() + n);
    return ymdOf(d);
  }

  // 指定日を含む週の月曜日を返す
  function mondayOf(dateStr) {
    var d = parseDateStr(dateStr);
    var dow = d.getDay(); // 0=日 … 6=土
    var diff = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + diff);
    return ymdOf(d);
  }

  function weekDates(weekStart) {
    var out = [];
    for (var i = 0; i < 7; i++) {
      var dateStr = addDaysStr(weekStart, i);
      out.push({ date: dateStr, dow: parseDateStr(dateStr).getDay() });
    }
    return out;
  }

  function fmtMD(dateStr) {
    return parseInt(dateStr.substring(5, 7), 10) + "/" + parseInt(dateStr.substring(8, 10), 10);
  }

  function weekLabel(weekStart) {
    return fmtMD(weekStart) + "〜" + fmtMD(addDaysStr(weekStart, 6));
  }

  function navWeek(delta) {
    state.weekStart = addDaysStr(state.weekStart, delta * 7);
    renderYmLabel();
    loadWeek(state.weekStart);
  }

  function navWeekToday() {
    state.weekStart = mondayOf(state.todayStr);
    renderYmLabel();
    loadWeek(state.weekStart);
  }

  function loadWeek(weekStart) {
    if (!hasApiAccess()) { openSettingsModal(); return; }
    var cached = weekCache.get(weekStart);
    if (cached) { renderWeekView(cached); return; }
    $weekLoading.hidden = false;
    $weekGrid.innerHTML = "";
    var from = weekStart;
    var to = addDaysStr(weekStart, 7);
    serverCall("listWeekData", from, to)
      .then(function (data) {
        weekCache.set(weekStart, data);
        if (weekStart === state.weekStart) renderWeekView(data);
      })
      .catch(function (err) { handleServerError(err, "週データの読み込みに失敗しました"); })
      .finally(function () { $weekLoading.hidden = true; });
  }

  // 表示範囲(時間軸)の開始・終了分を、config既定値とはみ出す予定に合わせて時間単位で決める
  function weekTimeRange(events) {
    var startMin = timeToMin(state.config.dayStart);
    var endMin = timeToMin(state.config.dayEnd);
    events.forEach(function (ev) {
      if (ev.allDay) return;
      var s = timeToMin(ev.start.substring(11));
      var sameDay = ev.end.substring(0, 10) === ev.start.substring(0, 10);
      var e = sameDay ? timeToMin(ev.end.substring(11)) : 24 * 60;
      startMin = Math.min(startMin, Math.floor(s / 60) * 60);
      endMin = Math.max(endMin, Math.min(24 * 60, Math.ceil(e / 60) * 60));
    });
    return { startMin: startMin, endMin: endMin };
  }

  function weekMinToPx(min, startMin) {
    return (min - startMin) * (WEEK_PX_PER_HOUR / 60);
  }

  // ベース層(繰り返し予定)の日ごとの重なり判定。重なる後発イベントは幅70%右寄せ+前面
  function layoutBaseEvents(evList) {
    var placed = [];
    return evList.map(function (ev) {
      var narrow = placed.some(function (p) { return p.startMin < ev.endMin && p.endMin > ev.startMin; });
      placed.push({ startMin: ev.startMin, endMin: ev.endMin });
      return { ev: ev, narrow: narrow };
    });
  }

  // 前面カード同士の重なりを列分割(重なるカード同士でのみ左右分割)
  function layoutCardEvents(evList) {
    var sorted = evList.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var clusters = [];
    var cur = null;
    sorted.forEach(function (ev) {
      if (cur && ev.startMin < cur.maxEnd) {
        cur.items.push(ev);
        cur.maxEnd = Math.max(cur.maxEnd, ev.endMin);
      } else {
        cur = { items: [ev], maxEnd: ev.endMin };
        clusters.push(cur);
      }
    });
    var out = [];
    clusters.forEach(function (cl) {
      var colsEnd = []; // 各列の最終終了分
      cl.items.forEach(function (ev) {
        var col = colsEnd.findIndex(function (end) { return end <= ev.startMin; });
        if (col < 0) { col = colsEnd.length; colsEnd.push(ev.endMin); } else { colsEnd[col] = ev.endMin; }
        out.push({ ev: ev, col: col, cols: 0 });
      });
      out.filter(function (o) { return cl.items.indexOf(o.ev) >= 0; }).forEach(function (o) { o.cols = colsEnd.length; });
    });
    return out;
  }

  function renderWeekView(data) {
    var dates = weekDates(state.weekStart);
    var events = data.events || [];
    var range = weekTimeRange(events);
    var bodyHeight = weekMinToPx(range.endMin, range.startMin);

    // 日付キー→そのイベント群
    var byDate = {};
    dates.forEach(function (d) { byDate[d.date] = { allDay: [], base: [], card: [] }; });
    events.forEach(function (ev) {
      if (ev.allDay) {
        if (byDate[ev.date]) byDate[ev.date].allDay.push(ev);
        return;
      }
      var date = ev.start.substring(0, 10);
      if (!byDate[date]) return;
      var startMin = timeToMin(ev.start.substring(11));
      var sameDay = ev.end.substring(0, 10) === date;
      var endMin = sameDay ? timeToMin(ev.end.substring(11)) : 24 * 60;
      if (endMin <= startMin) endMin = startMin + 30;
      var item = { title: ev.title, calendarName: ev.calendarName, startMin: startMin, endMin: endMin,
        startLabel: ev.start.substring(11), endLabel: sameDay ? ev.end.substring(11) : "24:00" };
      (ev.recurring ? byDate[date].base : byDate[date].card).push(item);
    });

    var tasksByDate = {};
    dates.forEach(function (d) { tasksByDate[d.date] = []; });
    (data.tasks || []).forEach(function (t) { if (tasksByDate[t.due]) tasksByDate[t.due].push(t); });

    var hourLabels = [];
    for (var m = range.startMin; m < range.endMin; m += 60) {
      hourLabels.push("<div class='wk-hour-label' style='top:" + weekMinToPx(m, range.startMin) + "px'>" +
        pad2(Math.floor(m / 60)) + ":00</div>");
    }

    var html = ["<div class='wk-time-axis'><div class='wk-time-axis-head'></div>" +
      "<div class='wk-time-axis-body' style='height:" + bodyHeight + "px'>" + hourLabels.join("") + "</div></div>"];

    var weekHolidays = data.holidays || {};
    dates.forEach(function (d) {
      var cls = dayClass(d, weekHolidays, true);
      if (d.date === state.todayStr) cls += " is-today";
      var info = byDate[d.date];
      var holidayName = weekHolidays[d.date] || "";

      var headHtml = "<div class='wk-day-head " + cls + "'>" +
        "<span class='wk-day-d'>" + fmtMD(d.date) + "(" + WEEKDAYS[d.dow] + ")</span>" +
        (holidayName ? "<span class='wk-day-holiday-name'>" + escapeHtml(truncate(holidayName, 8)) + "</span>" : "") +
        "</div>";

      var stripHtml = "<div class='wk-day-strip'>" +
        info.allDay.map(function (ev) {
          return "<span class='wk-badge-allday' title='" + escapeHtml(ev.title + "(" + (ev.calendarName || "") + ")") + "'>" +
            escapeHtml(truncate(ev.title, 10)) + "</span>";
        }).join("") +
        (tasksAvailableForRender(data) ? tasksByDate[d.date].map(function (t) {
          return "<span class='wk-badge-task' title='" + escapeHtml(t.title + "(" + (t.listName || "") + ")") + "'>" +
            "☐ " + escapeHtml(truncate(t.title, 10)) + "</span>";
        }).join("") : "") +
        "</div>";

      var baseHtml = layoutBaseEvents(info.base).map(function (l) {
        var ev = l.ev;
        var top = weekMinToPx(ev.startMin, range.startMin);
        var height = Math.max(weekMinToPx(ev.endMin, range.startMin) - top, 10);
        var style = "top:" + top + "px;height:" + height + "px;" +
          (l.narrow ? "width:70%;left:30%;z-index:2;" : "width:100%;left:0;z-index:1;");
        return "<div class='wk-base' style='" + style + "' title='" +
          escapeHtml(ev.title + " " + ev.startLabel + "-" + ev.endLabel + "(" + (ev.calendarName || "") + ")") + "'>" +
          "<span class='wk-ev-time'>" + ev.startLabel + "</span> " + escapeHtml(truncate(ev.title, 10)) + "</div>";
      }).join("");

      var cardHtml = layoutCardEvents(info.card).map(function (l) {
        var ev = l.ev;
        var top = weekMinToPx(ev.startMin, range.startMin);
        var height = Math.max(weekMinToPx(ev.endMin, range.startMin) - top, 10);
        var areaLeft = 15, areaWidth = 85;
        var w = areaWidth / l.cols;
        var left = areaLeft + l.col * w;
        var style = "top:" + top + "px;height:" + height + "px;left:" + left + "%;width:" + w + "%;";
        return "<div class='wk-card' style='" + style + "' title='" +
          escapeHtml(ev.title + " " + ev.startLabel + "-" + ev.endLabel + "(" + (ev.calendarName || "") + ")") + "'>" +
          "<span class='wk-ev-time'>" + ev.startLabel + "</span> " + escapeHtml(truncate(ev.title, 10)) + "</div>";
      }).join("");

      html.push("<div class='wk-day-col'>" + headHtml + stripHtml +
        "<div class='wk-day-body " + cls + "' style='height:" + bodyHeight + "px'>" + baseHtml + cardHtml + "</div></div>");
    });

    $weekGrid.innerHTML = "<div class='wk-grid'>" + html.join("") + "</div>";
    $weekTasksNote.hidden = !!data.tasksAvailable;
  }

  function tasksAvailableForRender(data) {
    return !!data.tasksAvailable;
  }

  /* ===== 保存(デバウンス+直列化) ===== */

  function markRecordsDirty() { dirtyRecords = true; scheduleSave(); }
  function markDaysDirty() { dirtyDays = true; scheduleSave(); }

  function scheduleSave() {
    setSaveStatus("dirty");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (saving) { savePending = true; return Promise.resolve(); }
    if (!dirtyRecords && !dirtyDays) return Promise.resolve();
    saving = true;
    setSaveStatus("saving");
    var ym = state.ym;
    var doRecords = dirtyRecords, doDays = dirtyDays;
    dirtyRecords = false;
    dirtyDays = false;

    var chain = Promise.resolve();
    if (doRecords) chain = chain.then(function () { return serverCall("saveMonthRecords", ym, recordsToArray()); });
    if (doDays) chain = chain.then(function () { return serverCall("saveMonthDays", ym, daysToArray()); });

    return chain
      .then(function () { setSaveStatus("saved"); })
      .catch(function (err) {
        // 失敗分を dirty に戻し、ステータス表示から手動再試行できるようにする
        if (doRecords) dirtyRecords = true;
        if (doDays) dirtyDays = true;
        setSaveStatus("error");
        handleServerError(err, "保存に失敗しました(ステータス表示をクリックで再試行)");
      })
      .finally(function () {
        saving = false;
        if (savePending || dirtyRecords || dirtyDays) {
          savePending = false;
          if ($saveStatus.classList.contains("is-error")) return; // エラー時は手動再試行に任せる
          scheduleSave();
        }
      });
  }

  // 即時保存(タイマーを止めて flush し、完了まで待つ)。月切替・終了前用
  function flushSaveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return flushSave();
  }

  function recordsToArray() {
    return Object.keys(state.records).map(function (key) {
      var p = key.split("|");
      var r = state.records[key];
      return { date: p[0], time: p[1], code: r.code, sub: r.sub || "", memo: r.memo || "" };
    });
  }

  function daysToArray() {
    return Object.keys(state.days).map(function (date) {
      var d = state.days[date];
      return { date: date, paidLeave: !!d.paidLeave, memo: d.memo || "" };
    });
  }

  function setSaveStatus(kind) {
    $saveStatus.classList.remove("is-saved", "is-saving", "is-error");
    if (kind === "saving") { $saveStatus.classList.add("is-saving"); $saveStatus.textContent = "保存中…"; }
    else if (kind === "error") { $saveStatus.classList.add("is-error"); $saveStatus.textContent = "保存失敗(クリックで再試行)"; }
    else if (kind === "dirty") { $saveStatus.classList.add("is-saving"); $saveStatus.textContent = "変更あり…"; }
    else { $saveStatus.classList.add("is-saved"); $saveStatus.textContent = "保存済み"; }
  }

  /* ===== グローバルイベント(Esc・外クリック・離脱ガード) ===== */

  function bindGlobalEvents() {
    // Esc: 最前面のものから1つずつ閉じる(ポップオーバー → パレットメニュー → モーダル)
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        if (closePopover()) return;
        if (closeSubMenus()) return;
        closeModal();
        return;
      }
      // Ctrl+Z で元に戻す(入力欄では文字編集のundoを優先)
      if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === "z") {
        var t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        ev.preventDefault();
        undo();
      }
    });

    // 外側クリックで閉じる
    document.addEventListener("mousedown", function (ev) {
      if (!$popover.hidden && !$popover.contains(ev.target)) closePopover();
      if (!ev.target.closest(".pal-group")) closeSubMenus();
    });
    $modalOverlay.addEventListener("mousedown", function (ev) {
      if (ev.target === $modalOverlay) closeModal();
    });

    // 未保存のままタブを閉じようとしたら警告
    window.addEventListener("beforeunload", function (ev) {
      if (dirtyRecords || dirtyDays || saving) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  }

  /* ===== トースト ===== */

  var toastTimer = null;
  function showToast(msg, isError) {
    $toast.textContent = msg;
    $toast.classList.toggle("is-error", !!isError);
    $toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 2500);
  }

  /* ===== 汎用ユーティリティ ===== */

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function ymdOf(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function timeToMin(t) {
    var p = t.split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function minToTime(min) {
    return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60);
  }

  function formatDateJp(dateStr) {
    var m = parseInt(dateStr.substring(5, 7), 10);
    var d = parseInt(dateStr.substring(8, 10), 10);
    var y = parseInt(dateStr.substring(0, 4), 10);
    var dow = new Date(y, m - 1, d).getDay();
    return m + "/" + d + "(" + WEEKDAYS[dow] + ")";
  }

  function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.substring(0, n) : s;
  }

  function normalizeColor(c) {
    return /^#[0-9a-fA-F]{6}$/.test(c || "") ? c : "#cccccc";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function escapeAttr(s) { return escapeHtml(s); }

})();
