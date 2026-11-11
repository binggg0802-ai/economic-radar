import { taipeiParts, addDays } from './util.mjs';

// 任意時區的當地日期與分鐘數（用 Intl，自動處理美國夏令時間）。
export function zonedParts(d, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: wd };
}

// 把「某時區的當地日期時間」換成 UTC 時刻（用來算 BLS 08:30 ET 對應的台北時間）。
export function zonedToUtc(date, hhmm, timeZone) {
  const [h, m] = hhmm.split(':').map(Number);
  let guess = new Date(Date.UTC(...date.split('-').map((x, i) => i === 1 ? Number(x) - 1 : Number(x)), h, m));
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone);
    const want = Date.UTC(...date.split('-').map((x, j) => j === 1 ? Number(x) - 1 : Number(x)), h, m);
    const got = Date.UTC(...p.date.split('-').map((x, j) => j === 1 ? Number(x) - 1 : Number(x)), Math.floor(p.minutes / 60), p.minutes % 60);
    guess = new Date(guess.getTime() + (want - got));
  }
  return guess;
}

// 證交所交易日：週末休市；休市日表上的日期休市（名稱含「開始交易」等特殊交易日除外）。
export function isTwseTradingDay(iso, holidays) {
  const wd = new Date(iso + 'T00:00:00Z').getUTCDay();
  const h = (holidays || []).find((x) => x.date === iso);
  if (h) return /開始交易|最後交易|補行交易/.test(h.name + (h.desc || '')) && !/休市|無交易|放假/.test(h.name + (h.desc || ''));
  return wd !== 0 && wd !== 6;
}

export function prevTradingDay(iso, holidays) {
  let d = addDays(iso, -1);
  for (let i = 0; i < 30 && !isTwseTradingDay(d, holidays); i++) d = addDays(d, -1);
  return d;
}

// ---- 各類資料的排程判斷：回傳 { run: boolean, reason } ----
// 原則：只在官方「可能已公布」的時段去抓；已取得就不重抓；日程未核對就不排程。

export function decideTwClose(now, record, holidays, win) {
  const p = taipeiParts(now);
  const trading = isTwseTradingDay(p.date, holidays);
  const hasToday = record && record.period === p.date && record.status === 'ok';
  if (!trading) {
    // 非交易日：每天最多一次對帳（確認上一交易日資料完整），其餘略過
    const lastTd = prevTradingDay(addDays(p.date, 1), holidays);
    if (record && record.period >= lastTd && record.status === 'ok') return { run: false, reason: `非交易日（${p.date}），上一交易日 ${lastTd} 的資料已取得` };
    return { run: true, reason: `非交易日，但尚未確認上一交易日 ${lastTd} 的資料` };
  }
  if (hasToday) return { run: false, reason: `今日 ${p.date} 收盤已取得，不重複抓取` };
  if (p.minutes < win.open_min) {
    const prev = prevTradingDay(p.date, holidays);
    if (record && record.period >= prev && record.status === 'ok') return { run: false, reason: `收盤前；上一交易日 ${prev} 已取得` };
    return { run: true, reason: `收盤前，補抓上一交易日 ${prev}` };
  }
  return { run: true, reason: `交易日 ${p.date} 收盤後，檢查官方是否已公布` };
}

export function decideScheduledRelease(now, record, calendar, { after_min = 5, window_min = 360 } = {}) {
  if (!calendar || !calendar.verified_on || !(calendar.releases || []).length) {
    return { run: false, reason: '官方公布日程尚未核對，暫不排程（不猜測發布日）' };
  }
  const tz = calendar.time_zone;
  for (const r of calendar.releases) {
    const at = zonedToUtc(r.date, r.time, tz);
    const diffMin = (now.getTime() - at.getTime()) / 60000;
    const have = record && record.period === r.reference_month && record.status === 'ok';
    if (diffMin >= after_min && diffMin <= window_min) {
      if (have) return { run: false, reason: `${r.reference_month} 已取得` };
      return { run: true, reason: `${r.reference_month} 已過官方公布時間 ${r.date} ${r.time}（${tz}）`, release_at: at.toISOString() };
    }
  }
  return { run: false, reason: '目前不在任何官方公布時段內' };
}

// ---- 證交所收盤資料的新鮮度判斷（2026-11-11 依實測修正） ----
// 實測：證交所 OpenAPI 當日收盤在 18:10 仍未更新（13:19–18:10 回應位元組完全相同），
// 因此不再用「當日 18:00」當逾期門檻。改為：某交易日 D 的收盤，只要在「D 之後下一個交易日的 09:00（開盤前）」
// 之前取得都算正常的「尚未公布」；超過才算「資料逾期」。這個門檻是暫定值，會依實際首次取得時間調整。
export const TW_CLOSE = { close_min: 13 * 60 + 30, deadline_hhmm: '09:00', deadline_note: '暫定：下一交易日 09:00（開盤前）。依實測首次取得時間調整。' };

export function nextTradingDayAfter(iso, holidays) {
  let d = addDays(iso, 1);
  for (let i = 0; i < 40 && !isTwseTradingDay(d, holidays); i++) d = addDays(d, 1);
  return d;
}

// 交易日 D 的收盤最晚應在何時取得（台北時間 ISO 字串）
export function closeDeadline(D, holidays, cfg = TW_CLOSE) {
  return `${nextTradingDayAfter(D, holidays)}T${cfg.deadline_hhmm}:00+08:00`;
}

// 依已保存的最新資料日期判斷新鮮度：ok／pending／stale
//   M = 已保存日期之後的下一個交易日；M 尚未收盤 → ok；M 已收盤但未過期限 → pending；已過期限 → stale
export function twCloseFreshness(lastDate, now, holidays, cfg = TW_CLOSE) {
  const p = taipeiParts(now);
  if (!lastDate) return { state: 'no_data', due: null, deadline: null };
  const M = nextTradingDayAfter(lastDate, holidays);
  const closed = M < p.date || (M === p.date && p.minutes >= cfg.close_min);
  if (!closed) return { state: 'ok', due: M, deadline: closeDeadline(M, holidays, cfg), reason: `下一個交易日 ${M} 尚未收盤，${lastDate} 即為最新收盤` };
  const deadline = closeDeadline(M, holidays, cfg);
  if (now < new Date(deadline)) return { state: 'pending', due: M, deadline, reason: `${M} 已收盤，官方尚未公布收盤資料（最晚應於 ${deadline.slice(0, 16).replace('T', ' ')} 前取得）；目前顯示 ${lastDate} 的收盤` };
  return { state: 'stale', due: M, deadline, reason: `${M} 的收盤應於 ${deadline.slice(0, 16).replace('T', ' ')} 前取得，至今仍只有 ${lastDate} 的資料` };
}

// 排程判斷（取代 decideTwClose）：只有「有新的交易日收盤待取得」或「上次執行失敗需重試」時才連線
export function decideTwRun(now, record, holidays) {
  if (!record || record.value == null) return { run: true, reason: '尚未有任何成功資料，需取得' };
  if (['error', 'source_anomaly'].includes(record.status)) return { run: true, reason: `上次結果為 ${record.status}，重試` };
  const f = twCloseFreshness(record.period, now, holidays);
  if (f.state === 'ok') return { run: false, reason: `無新的交易日收盤待取得（${f.reason}）` };
  return { run: true, reason: f.state === 'pending' ? `等待 ${f.due} 收盤公布，檢查官方是否已更新` : `${f.due} 收盤已逾期，持續檢查` };
}
