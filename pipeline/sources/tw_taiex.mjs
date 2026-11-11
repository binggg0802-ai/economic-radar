import { rocToIso, toNumber, addDays, taipeiParts } from '../lib/util.mjs';

// 台灣加權股價指數：只使用證交所官方 OpenAPI（openapi.twse.com.tw），不爬一般網頁。
export const META = {
  id: 'tw_taiex',
  name: '臺灣證券交易所 發行量加權股價指數',
  short_name: '台灣加權指數',
  unit: '點',
  data_type: 'close', // 收盤數據（盤後資訊），不是即時或延遲行情
  data_type_label: '收盤數據（盤後公布，非即時）',
  frequency: '每個交易日',
  publisher: '臺灣證券交易所',
  sources: {
    primary: { name: '證交所 OpenAPI：每日市場成交資訊（FMTQIK）', url: 'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK' },
    cross_check: { name: '證交所 OpenAPI：每日收盤行情－大盤統計資訊（MI_INDEX）', url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX' },
    calendar: { name: '證交所 OpenAPI：市場開休市日期（holidaySchedule）', url: 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule' },
    human: { name: '證交所網站：每日市場成交資訊', url: 'https://www.twse.com.tw/zh/trading/historical/fmtqik.html' }
  },
  official_release_note: '證交所 OpenAPI 未提供每筆資料的官方發布時間戳記；系統改記錄「首次取得時間」。',
  license_note: '資料來源為臺灣證券交易所。商業使用前須確認證交所 OpenAPI 使用規範與「交易資訊使用管理辦法」。',
  // 依證交所交易時間 09:00–13:30，收盤後才可能有當日資料。超過 18:00 仍未出現視為「逾期」。
  window: { expect_after_min: 14 * 60, stale_after_min: 18 * 60 }
};

const INDEX_NAME = '發行量加權股價指數';

export function parseFmtqik(json) {
  if (!Array.isArray(json)) throw new Error('FMTQIK 回應不是陣列');
  const rows = json.map((r, i) => {
    const date = rocToIso(r.Date);
    const close = toNumber(r.TAIEX);
    const change = toNumber(r.Change);
    const value = toNumber(r.TradeValue);
    if (!date || close == null || change == null) throw new Error(`FMTQIK 第 ${i + 1} 筆欄位格式不符：${JSON.stringify(r)}`);
    return { date, close, change, trade_value: value };
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseMiIndex(json) {
  if (!Array.isArray(json)) throw new Error('MI_INDEX 回應不是陣列');
  const r = json.find((x) => (x['指數'] || '').trim() === INDEX_NAME);
  if (!r) return null; // 找不到就是找不到，不用其他指數代替
  const sign = (r['漲跌'] || '').trim();
  const pts = toNumber(r['漲跌點數']);
  return { date: rocToIso(r['日期']), close: toNumber(r['收盤指數']), change: pts == null ? null : (sign === '-' ? -pts : pts), raw: r };
}

export function parseHolidays(json) {
  if (!Array.isArray(json)) throw new Error('holidaySchedule 回應不是陣列');
  return json.map((r) => ({ date: rocToIso(r.Date), name: r.Name, desc: r.Description || '' })).filter((x) => x.date);
}

// 是否為交易日：週末休市；holidaySchedule 列出的日期（名稱含「交易」字樣的特殊交易日除外）休市。
export function isTradingDay(iso, holidays) {
  const wd = new Date(iso + 'T00:00:00Z').getUTCDay();
  const h = holidays.find((x) => x.date === iso);
  if (h) return /開始交易|最後交易|補行交易/.test(h.name + h.desc) && !/休市|無交易|放假/.test(h.name + h.desc) ? true : false;
  return wd !== 0 && wd !== 6;
}

// 依台北時間判斷「現在應該看到哪一天的收盤」以及目前是否還在等待公布。
export function expectedPeriod(now, holidays, win = META.window) {
  const p = taipeiParts(now);
  const todayTrading = isTradingDay(p.date, holidays);
  if (todayTrading && p.minutes >= win.expect_after_min) {
    return { expected: p.date, today_is_trading_day: true, waiting_for_today: p.minutes < win.stale_after_min };
  }
  let d = addDays(p.date, -1);
  for (let i = 0; i < 20 && !isTradingDay(d, holidays); i++) d = addDays(d, -1);
  return { expected: d, today_is_trading_day: todayTrading, waiting_for_today: false, before_close: todayTrading };
}
