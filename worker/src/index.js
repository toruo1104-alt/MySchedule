/**
 * Worker エントリポイント。
 * 通信仕様(docs/仕様書.md 3章 / GAS.txt 冒頭コメント)と完全互換:
 *   POST /api body(text/plain可・Content-Type不問): {"token":"...","fn":"関数名","args":[...]}
 *   レスポンス(JSON): {"ok":true,"data":...} | {"ok":false,"error":"..."}
 *   HTTPステータスは常に200(GAS互換。フロントは res.ok で判定する)。
 * GET /api は死活確認用。それ以外は静的アセット(web/)を配信する。
 * 並行稼働期間中、Pages配信のフロントからも呼べるよう /api レスポンスにCORSを付与する。
 */
import { registry } from './actions/registry.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonOut(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

// トークン照合。env.API_TOKEN と一致しなければすべて拒否(GAS.txt 76-81行 checkToken_ 相当)
function checkToken(env, token) {
  const expected = String(env.API_TOKEN || '');
  if (!expected) throw new Error('サーバーの apiToken が未設定です');
  if (String(token || '') !== expected) throw new Error('認証エラー: トークンが一致しません');
}

async function handleApi(request, env) {
  let res;
  try {
    const bodyText = await request.text();
    const req = JSON.parse(bodyText || '{}');
    checkToken(env, req.token);
    const fn = String(req.fn || '');
    // fn:'constructor' 等のprototype継承プロパティがregistry[fn]で解決されてしまう実測があるため、
    // 自身のプロパティかどうかを明示的に確認する(⑩)
    const handler = Object.prototype.hasOwnProperty.call(registry, fn) ? registry[fn] : undefined;
    if (!handler) throw new Error('不明なAPI: ' + fn);
    const data = await handler(env.DB, env, ...(req.args || []));
    res = { ok: true, data };
  } catch (err) {
    res = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return jsonOut(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 末尾スラッシュ(/api/)も /api として扱う。ルート '/' はここで '' に縮まり /api とは一致しないため対象外
    const apiPath = url.pathname.replace(/\/+$/, '');
    if (apiPath === '/api') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        return handleApi(request, env);
      }
      return jsonOut({ ok: true, app: 'MySchedule API' });
    }
    return env.ASSETS.fetch(request);
  }
};
