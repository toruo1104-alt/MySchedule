/**
 * GAS側プロキシ(祝日取得・カレンダー連携・週データ)への中継。
 * 契約: POST {token: env.GAS_TOKEN, fn, args} → {ok:true,data} | {ok:false,error}
 * (GAS.txt の通信仕様と同じ封筒。プロキシ側の実装は別途)。
 * タイムアウト/ネットワーク失敗時は1回だけ自動リトライする(500ms待ってから)。
 */
const GAS_TIMEOUT_MS = 12000;
const GAS_RETRY_WAIT_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchGas(env, fn, args) {
  return fetch(env.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ token: env.GAS_TOKEN, fn, args }),
    signal: AbortSignal.timeout(GAS_TIMEOUT_MS)
  });
}

// AbortSignal.timeout()由来のタイムアウト、またはfetchのネットワーク失敗(TypeError)かどうか
function isTimeoutOrNetworkError(e) {
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError);
}

export async function callGasProxy(env, fn, args) {
  if (!env.GAS_URL) throw new Error('GAS_URL が未設定です');
  let res;
  try {
    res = await fetchGas(env, fn, args);
  } catch (e) {
    if (!isTimeoutOrNetworkError(e)) throw e;
    await sleep(GAS_RETRY_WAIT_MS);
    try {
      res = await fetchGas(env, fn, args);
    } catch (e2) {
      if (e2 && (e2.name === 'TimeoutError' || e2.name === 'AbortError')) throw new Error('GASプロキシが応答しません(タイムアウト)');
      throw e2;
    }
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('GASプロキシの応答が不正です');
  }
  if (!json || json.ok !== true) {
    throw new Error((json && json.error) ? json.error : 'GASプロキシ呼び出しに失敗しました');
  }
  return json.data;
}
