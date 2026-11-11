import { createHash } from 'node:crypto';

// 所有時間一律以 ISO 8601 + 台北時區偏移（+08:00）輸出，避免前端誤判。
export function isoTaipei(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
}

// 取得台北當地的日期、星期、時分（不依賴執行環境時區）。
export function taipeiParts(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return {
    date: t.toISOString().slice(0, 10),
    weekday: t.getUTCDay(), // 0=日 … 6=六
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes()
  };
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// 民國日期：'1151110' 或 '115/11/10' → '2026-11-10'。格式不符回傳 null（不猜）。
export function rocToIso(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]) + 1911, mo = Number(m[2]), da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  const back = new Date(iso + 'T00:00:00Z');
  if (back.toISOString().slice(0, 10) !== iso) return null; // 例如 2/30
  return iso;
}

// '42,711.92' → 42711.92；不是合法數字回傳 null（不補值）。
export function toNumber(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s !== 'string') return null;
  const t = s.replace(/,/g, '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 帶逾時與有限重試的 HTTP 取得；回傳原始文字與證據（狀態碼、位元組數、雜湊）。
export async function fetchText(url, { timeoutMs = 20000, retries = 2, fetchImpl = fetch } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = new Date();
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'EconomicRadar-DataPipeline/0.1 (+https://github.com/binggg0802-ai/economic-radar)' } });
      const text = await res.text();
      clearTimeout(timer);
      const evidence = { url, http_status: res.status, bytes: Buffer.byteLength(text), sha256: sha256(text), fetched_at: isoTaipei(started), attempt: attempt + 1 };
      if (!res.ok) { lastErr = Object.assign(new Error(`HTTP ${res.status}`), { evidence }); }
      else return { text, evidence };
    } catch (e) {
      clearTimeout(timer);
      lastErr = Object.assign(new Error(e.name === 'AbortError' ? `逾時（${timeoutMs}ms）` : e.message + (e.cause && e.cause.code ? `（${e.cause.code}）` : '')), { evidence: { url, fetched_at: isoTaipei(started), attempt: attempt + 1 } });
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastErr;
}
