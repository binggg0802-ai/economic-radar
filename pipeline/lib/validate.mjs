import { taipeiParts } from './util.mjs';

// 每項檢查都回傳 { id, ok, detail }；只要有一項 ok=false，該次資料就不發布為新值。
export function validateTaiex({ rows, cross, now }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  add('rows_present', rows.length > 0, `取得 ${rows.length} 筆`);
  if (!rows.length) return checks;
  const last = rows[rows.length - 1];
  const today = taipeiParts(now).date;
  add('not_future', last.date <= today, `最新資料日 ${last.date}，台北今日 ${today}`);
  add('range', last.close > 1000 && last.close < 200000, `收盤 ${last.close} 落在合理範圍 1,000–200,000`);
  add('ascending_unique', rows.every((r, i) => i === 0 || r.date > rows[i - 1].date), '日期遞增且不重複');
  // 相鄰兩日：今日收盤 − 昨日收盤 = 官方公布的漲跌點數（容許 0.01 四捨五入）
  const bad = [];
  for (let i = 1; i < rows.length; i++) {
    const diff = Math.round((rows[i].close - rows[i - 1].close) * 100) / 100;
    if (Math.abs(diff - rows[i].change) > 0.011) bad.push(`${rows[i].date}: 計算 ${diff} vs 公布 ${rows[i].change}`);
  }
  add('change_consistent', bad.length === 0, bad.length ? bad.join('；') : `${rows.length - 1} 組相鄰交易日的漲跌點數全部吻合`);
  // 台股個股漲跌幅限制 10%，大盤單日變動超過 10% 視為異常，需人工確認，不自動發布
  if (rows.length > 1) {
    const prev = rows[rows.length - 2];
    const pct = (last.close / prev.close - 1) * 100;
    add('daily_move_sane', Math.abs(pct) <= 10, `單日變動 ${pct.toFixed(2)}%（上限 ±10%）`);
  }
  // 同一來源的第二個端點交叉比對（MI_INDEX 大盤統計）
  if (!cross) add('cross_check', false, 'MI_INDEX 找不到「發行量加權股價指數」，無法交叉比對');
  else if (cross.date !== last.date) add('cross_check', true, `MI_INDEX 日期 ${cross.date} 與 FMTQIK 最新 ${last.date} 不同，略過數值比對（兩端點更新時間不同）`);
  else add('cross_check', Math.abs(cross.close - last.close) < 0.005 && Math.abs(cross.change - last.change) < 0.005, `MI_INDEX ${cross.close}（${cross.change}） vs FMTQIK ${last.close}（${last.change}）`);
  return checks;
}
