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
