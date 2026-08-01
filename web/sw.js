/* ============================================================
   MySchedule — 最小のService Worker(ホーム画面インストール用)

   オフラインキャッシュは実装しない(要件外・データ整合性のリスクを避ける)。
   fetchはネットワークへの素通し(respondWithしない)のみ。
============================================================ */
self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function () {
  // 何もしない(素通し)。respondWithしないことで通常のネットワーク処理に任せる。
});
