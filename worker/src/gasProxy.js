/**
 * GAS側プロキシ(祝日取得・カレンダー連携・週データ)への中継。
 * 契約: POST {token: env.GAS_TOKEN, fn, args} → {ok:true,data} | {ok:false,error}
 * (GAS.txt の通信仕様と同じ封筒。プロキシ側の実装は別途)。
 */
export async function callGasProxy(env, fn, args) {
  if (!env.GAS_URL) throw new Error('GAS_URL が未設定です');
  let res;
  try {
    res = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: env.GAS_TOKEN, fn, args }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('GASプロキシが応答しません(タイムアウト)');
    throw e;
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
