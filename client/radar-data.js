// 經濟雷達：前端唯一的資料讀取入口。首頁／雷達／市場／新聞／報告都只能透過這裡取數字。
// 規則：
//  1. 只讀資料管線產生的 manifest.json 與 series/*.json，不得在頁面寫死數值。
//  2. 顯示前再檢查一次 valid_until：超過時間仍沒有新資料，一律改為「資料逾期」，
//     即使排程整個停擺、JSON 還寫著「已更新」，也不會把舊資料標成最新。
//  3. 沒有經驗證的數值（從未成功取得／尚未接入／讀檔失敗）時，value 一律為 null，頁面不得顯示數字。
(function (global) {
  var LABEL = { ok: '已更新', pending: '尚未公布', error: '更新失敗', stale: '資料逾期', no_data: '從未成功取得', source_anomaly: '來源異常', not_connected: '尚未接入', load_error: '更新失敗' };

  function applyDisplayStatus(r, now) {
    now = now || new Date();
    var out = Object.assign({}, r);
    var hasValue = typeof r.value === 'number' && r.status !== 'no_data' && r.status !== 'not_connected';
    if (!hasValue) { out.value = null; out.display_status = r.status || 'no_data'; }
    else if (r.valid_until && now > new Date(r.valid_until) && (r.status === 'ok' || r.status === 'pending')) {
      out.display_status = 'stale';
      out.display_reason = '超過預期更新時間（' + r.valid_until.replace('T', ' ').replace('+08:00', '') + ' 台北）仍沒有新資料，以下為 ' + r.period + ' 的資料。';
    } else {
      out.display_status = r.status;
      // 更新失敗／來源異常時，說明保留的是哪一天的資料
      if ((r.status === 'error' || r.status === 'source_anomaly') && r.period) {
        out.display_reason = (r.status_reason || '') + '。目前顯示最後一次成功驗證的 ' + r.period + ' 資料（取得於 ' + String(r.last_success_at || '').replace('T', ' ').replace('+08:00', '') + '）。';
      }
    }
    out.display_label = LABEL[out.display_status] || out.display_status;
    out.display_reason = out.display_reason || r.status_reason || '';
    out.display_is_latest = out.display_status === 'ok';
    return out;
  }

  async function getJson(url) {
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // base：資料根目錄，例如 'data/' 或 'https://…/data/'
  async function loadSeries(base, code, now) {
    try { return applyDisplayStatus(await getJson(base + 'series/' + code + '.json'), now); }
    catch (e) { return { code: code, value: null, display_status: 'load_error', display_label: LABEL.load_error, display_reason: '無法讀取資料檔（' + e.message + '），不顯示數字。', display_is_latest: false }; }
  }

  async function loadManifest(base, now) {
    var m = await getJson(base + 'manifest.json');
    m.series = m.series.map(function (s) { return applyDisplayStatus(s, now); });
    return m;
  }

  var api = { applyDisplayStatus: applyDisplayStatus, loadSeries: loadSeries, loadManifest: loadManifest, LABEL: LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.RadarData = api;
})(typeof window !== 'undefined' ? window : globalThis);
