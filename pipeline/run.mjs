import { join } from 'node:path';
import { fetchText, isoTaipei, sha256, addDays } from './lib/util.mjs';
import { readJson, writeJsonAtomic, saveRaw, saveRawDedup, upsertHistory, appendRunLog } from './lib/store.mjs';
import { validateTaiex } from './lib/validate.mjs';
import { decideTwClose, isTwseTradingDay } from './lib/schedule.mjs';
import { REGISTRY } from './registry.mjs';
import { META, parseFmtqik, parseMiIndex, parseHolidays, expectedPeriod } from './sources/tw_taiex.mjs';

export const SCHEMA_VERSION = 2;

// 前端顯示用的五種狀態（加上「尚未接入」）。
export const STATUS_LABEL = {
  ok: '已更新',
  pending: '尚未公布',
  error: '更新失敗',
  stale: '資料逾期',
  no_data: '從未成功取得',
  not_connected: '尚未接入'
};

// 故障演練：只在測試時用，正式排程不會帶這些參數。
export function faultFetch(fetchImpl, fault) {
  if (!fault) return fetchImpl;
  return async (url, opts) => {
    if (fault === 'bad_host' && url.includes('FMTQIK')) return fetchImpl(url.replace('openapi.twse.com.tw', 'openapi.twse.invalid'), opts);
    const res = await fetchImpl(url, opts);
    if (!url.includes('FMTQIK') || !res.ok) return res;
    const text = await res.text();
    let out = text;
    if (fault === 'format_change') out = text.replace(/"TAIEX"/g, '"IndexValue"'); // 模擬官方改欄位名稱
    if (fault === 'old_data') { const a = JSON.parse(text); out = JSON.stringify(a.slice(0, Math.max(1, a.length - 2))); } // 模擬官方端點回傳較舊的資料
    if (fault === 'http_500') return { ok: false, status: 500, text: async () => 'Internal Server Error' };
    return { ok: res.ok, status: res.status, text: async () => out };
  };
}

function at18(iso) { return iso + 'T18:00:00+08:00'; }
function nextTradingDay(iso, holidays) {
  let d = addDays(iso, 1);
  for (let i = 0; i < 30 && !isTwseTradingDay(d, holidays); i++) d = addDays(d, 1);
  return d;
}

export async function runTaiex({ root = 'data', now = new Date(), fetchImpl = fetch, fault = null, force = false, trigger = 'manual' } = {}) {
  const started = isoTaipei(now);
  const seriesPath = join(root, 'series', META.id + '.json');
  const calPath = join(root, 'calendars', 'twse_holidays.json');
  const prev = await readJson(seriesPath, null);
  const cachedCal = await readJson(calPath, null);
  const reg = REGISTRY.find((r) => r.code === META.id);
  const log = { series: META.id, started_at: started, trigger, fault: fault || null, steps: [], source_health: [],
    before: prev ? { period: prev.period ?? null, value: prev.value ?? null, status: prev.status, data_version: prev.data_version ?? null } : null };
  const step = (name, ok, detail) => log.steps.push({ name, ok, detail });
  const finish = async (rec, result, reason) => {
    log.result = result; log.reason = reason; log.finished_at = isoTaipei(new Date());
    log.after = rec ? { period: rec.period ?? null, value: rec.value ?? null, status: rec.status, data_version: rec.data_version ?? null } : null;
    await appendRunLog(root, log);
    await updateMonitor(root, log, rec);
    return { record: rec, log };
  };

  // 0. 排程判斷：只在官方可能已公布、且尚未取得時才連線（不在固定時間假設已公布）
  if (!force) {
    const d = decideTwClose(now, prev, cachedCal ? cachedCal.holidays : [], { open_min: 14 * 60 });
    step('schedule', true, d);
    if (!d.run) return finish(prev, 'skipped', d.reason);
  }

  const base = {
    schema_version: SCHEMA_VERSION,
    code: META.id, id: META.id, name: reg.name, full_name: META.name, short_name: META.short_name, unit: META.unit,
    data_type: META.data_type, data_type_label: META.data_type_label, frequency: META.frequency,
    source: { publisher: META.publisher, name: META.sources.primary.name, url: META.sources.primary.url },
    raw_url: META.sources.primary.url, sources: META.sources,
    official_release_at: null, official_release_note: META.official_release_note,
    license: reg.license, last_attempt_at: started
  };
  const keepPrev = (status, reason, extra = {}) => {
    const has = prev && prev.value != null;
    const s = has ? status : 'no_data';
    return Object.assign({}, prev || {}, base, {
      status: s, status_label: STATUS_LABEL[s], status_reason: has ? reason : `從未成功取得經驗證的資料。本次：${reason}`,
      is_latest: false, verification: { status: 'failed', checked_at: started, reason },
      last_success_at: prev ? prev.last_success_at || null : null, data_version: prev ? prev.data_version || 0 : 0,
      value: has ? prev.value : null, period: has ? prev.period : null
    }, extra);
  };
  const fail = async (reason, extra) => { const rec = keepPrev('error', reason, extra); await writeJsonAtomic(seriesPath, rec); return finish(rec, rec.status, reason); };

  const f = faultFetch(fetchImpl, fault);
  const raw_files = [];
  const grab = async (name, url) => {
    try {
      const r = await fetchText(url, { fetchImpl: f });
      // 故障演練時被竄改過的回應不是官方原始資料：另存到 _fault_injected/，也不更新去重索引
      const injected = fault && name === 'FMTQIK';
      const saved = injected
        ? { path: await saveRaw(root, META.id + '/_fault_injected', started, `${name}.${fault}`, r.text), deduplicated: false }
        : await saveRawDedup(root, META.id, started, name, r.text, r.evidence.sha256);
      raw_files.push({ name, ...r.evidence, path: saved.path, deduplicated: saved.deduplicated, fault_injected: !!injected });
      log.source_health.push({ name, ok: true, http_status: r.evidence.http_status, bytes: r.evidence.bytes });
      step('fetch_' + name, true, { http_status: r.evidence.http_status, sha256: r.evidence.sha256, deduplicated: saved.deduplicated });
      return r;
    } catch (e) {
      log.source_health.push({ name, ok: false, http_status: e.evidence ? e.evidence.http_status ?? null : null, error: e.message });
      step('fetch_' + name, false, { error: e.message });
      return null;
    }
  };

  // 1. 取得
  const fm = await grab('FMTQIK', META.sources.primary.url);
  const mi = await grab('MI_INDEX', META.sources.cross_check.url);
  const hol = await grab('holidaySchedule', META.sources.calendar.url);
  if (!fm) return fail(`無法取得證交所 OpenAPI 主要端點：${log.source_health[0].error}`, { raw_files });

  // 2. 格式驗證（欄位不符直接停止，不猜測欄位）
  let rows, cross = null, holidays = cachedCal ? cachedCal.holidays : [], calendarSrc = cachedCal ? 'cache' : 'none';
  try {
    rows = parseFmtqik(JSON.parse(fm.text));
    if (mi) cross = parseMiIndex(JSON.parse(mi.text));
    if (hol) { holidays = parseHolidays(JSON.parse(hol.text)); calendarSrc = 'live'; await writeJsonAtomic(calPath, { fetched_at: started, source: META.sources.calendar.url, holidays }); }
    step('parse', true, { rows: rows.length, cross: cross ? cross.date : null, holidays: holidays.length, calendar: calendarSrc });
  } catch (e) {
    step('parse', false, { error: e.message });
    return fail(`官方回應格式不符，已停止更新：${e.message}`, { raw_files });
  }

  // 3. 數值驗證 + 4. 日期檢查 + 5. 官方來源交叉核對（validateTaiex 內含 range / not_future / change_consistent / cross_check）
  const checks = validateTaiex({ rows, cross, now });
  checks.push({ id: 'calendar', ok: true, detail: calendarSrc === 'live' ? '休市日表即時取得' : calendarSrc === 'cache' ? '休市日表取得失敗，使用上次保存的版本' : '無休市日表，僅以週末判斷交易日' });
  const passed = checks.every((c) => c.ok);
  step('validate', passed, checks);
  if (!passed) {
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.id}：${c.detail}`).join('；');
    return fail(`驗證未通過，新資料不發布：${failed}`, { validation: { passed: false, checks }, raw_files });
  }

  const last = rows[rows.length - 1], prevRow = rows[rows.length - 2] || null;

  // 防倒退：官方端點若回傳比已保存更舊的資料，不覆蓋較新的資料
  if (prev && prev.period && prev.value != null && last.date < prev.period) {
    const reason = `官方端點本次回傳的最新日期 ${last.date} 早於已保存的 ${prev.period}，保留較新的資料，不覆蓋`;
    step('regression_guard', false, reason);
    const rec = Object.assign({}, prev, { last_attempt_at: started, last_guard: { at: started, reason } });
    await writeJsonAtomic(seriesPath, rec);
    return finish(rec, 'kept_newer', reason);
  }
  step('regression_guard', true, prev && prev.period ? `新 ${last.date} ≥ 舊 ${prev.period}` : '無舊資料');

  // 6. 判定狀態
  const exp = expectedPeriod(now, holidays);
  let status, reason;
  if (last.date >= exp.expected) { status = 'ok'; reason = `最新收盤日 ${last.date}，即應有的最新交易日`; }
  else if (exp.waiting_for_today) { status = 'pending'; reason = `今日（${exp.expected}）為交易日，官方尚未公布收盤；目前顯示 ${last.date} 的收盤`; }
  else { status = 'stale'; reason = `應有 ${exp.expected} 的收盤，但官方最新只到 ${last.date}`; }

  // 7. 儲存
  const same = prev && prev.period === last.date && prev.value === last.close;
  const hist = await upsertHistory(join(root, 'history', META.id + '.json'), rows.map((r) => ({ period: r.date, value: r.close, change: r.change, trade_value: r.trade_value, first_seen_at: started })));
  const rec = Object.assign({}, base, {
    value: last.close, period: last.date, change: last.change,
    change_pct: prevRow ? Math.round((last.close / prevRow.close - 1) * 10000) / 100 : null,
    prev_period: prevRow ? prevRow.date : null, prev_value: prevRow ? prevRow.close : null,
    status, status_label: STATUS_LABEL[status], status_reason: reason, is_latest: status === 'ok',
    expected_period: exp.expected,
    // 超過這個時間仍沒有更新的資料，前端一律顯示「資料逾期」（即使排程整個停擺也不會誤標最新）
    valid_until: at18(nextTradingDay(last.date, holidays)),
    first_seen_at: same ? prev.first_seen_at : started, fetched_at: started, last_success_at: started,
    data_version: same ? prev.data_version || 1 : (prev && prev.data_version ? prev.data_version + 1 : 1),
    verification: { status: 'verified', checked_at: started, checks_passed: checks.length },
    validation: { passed: true, checks }, raw_files,
    history_points: hist.points.length, revisions: hist.revisions.length
  });
  delete rec.last_guard;
  await writeJsonAtomic(seriesPath, rec);
  return finish(rec, status, reason);
}

// 監控摘要：每次執行（含略過）都更新，連續失敗次數與來源健康度一目了然，避免靜默失敗。
export async function updateMonitor(root, log, rec) {
  const p = join(root, 'monitor', 'status.json');
  const m = await readJson(p, { series: {}, recent_runs: [] });
  const s = m.series[log.series] || { consecutive_failures: 0 };
  const failed = ['error', 'no_data'].includes(log.result);
  s.last_run_at = log.started_at;
  s.last_result = log.result;
  s.last_reason = log.reason;
  s.consecutive_failures = failed ? (s.consecutive_failures || 0) + 1 : (log.result === 'skipped' ? s.consecutive_failures || 0 : 0);
  if (failed) { s.last_failure_at = log.started_at; s.last_failure_reason = log.reason; }
  if (log.source_health.length) s.source_health = Object.fromEntries(log.source_health.map((h) => [h.name, { ...h, checked_at: log.started_at }]));
  s.last_success_at = rec ? rec.last_success_at || null : null;
  s.current = rec ? { period: rec.period ?? null, value: rec.value ?? null, status: rec.status, data_version: rec.data_version ?? null } : null;
  if (log.result !== 'skipped') s.last_change = { before: log.before, after: log.after, at: log.started_at };
  s.alert = s.consecutive_failures >= 3 ? `連續 ${s.consecutive_failures} 次失敗，需要人工處理` : null;
  m.series[log.series] = s;
  m.recent_runs = [{ at: log.started_at, series: log.series, trigger: log.trigger, fault: log.fault, result: log.result, reason: log.reason, before: log.before, after: log.after || null }, ...m.recent_runs].slice(0, 50);
  m.generated_at = isoTaipei(new Date());
  await writeJsonAtomic(p, m);
}

export async function writeManifest(root) {
  const series = [];
  for (const r of REGISTRY) {
    const rec = r.active ? await readJson(join(root, 'series', r.code + '.json'), null) : null;
    series.push({
      code: r.code, name: r.name, unit: r.unit, active: r.active,
      status: r.active ? (rec ? rec.status : 'no_data') : 'not_connected',
      status_label: STATUS_LABEL[r.active ? (rec ? rec.status : 'no_data') : 'not_connected'],
      period: rec ? rec.period ?? null : null, value: rec ? rec.value ?? null : null,
      last_success_at: rec ? rec.last_success_at || null : null, valid_until: rec ? rec.valid_until || null : null,
      data_version: rec ? rec.data_version ?? null : null,
      publisher: r.publisher, source_url: r.source_url, schedule: r.schedule, license: r.license,
      path: r.active ? `series/${r.code}.json` : null
    });
  }
  await writeJsonAtomic(join(root, 'manifest.json'), {
    schema_version: SCHEMA_VERSION, generated_at: isoTaipei(new Date()),
    note: '所有頁面只讀這份清單與 series/*.json。數值皆經驗證流程產生；未通過驗證不會發布；未接入的指標沒有數值。',
    series
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.env.DATA_ROOT || 'data';
  const fault = process.env.FAULT_INJECT || null;
  const force = process.env.FORCE_RUN === '1';
  const trigger = process.env.GITHUB_EVENT_NAME || 'manual';
  const { record, log } = await runTaiex({ root, fault, force, trigger });
  await writeManifest(root);
  console.log(JSON.stringify({ result: log.result, reason: log.reason, before: log.before, after: log.after, source_health: log.source_health, steps: log.steps.map((s) => `${s.name}:${s.ok ? 'ok' : 'FAIL'}`) }, null, 2));
  if (['error', 'no_data'].includes(log.result)) process.exitCode = 1;
}
