import { join } from 'node:path';
import { fetchText, isoTaipei } from './lib/util.mjs';
import { readJson, writeJsonAtomic, saveRaw, upsertHistory, appendRunLog } from './lib/store.mjs';
import { validateTaiex } from './lib/validate.mjs';
import { META, parseFmtqik, parseMiIndex, parseHolidays, expectedPeriod } from './sources/tw_taiex.mjs';

const STATUS_LABEL = {
  ok: '已更新：最新一個交易日的收盤資料',
  pending: '官方尚未公布今日收盤，顯示上一交易日資料',
  stale: '資料逾期：超過預期時間仍未取得最新收盤',
  error: '更新失敗：本次未取得可信資料，顯示上次成功的資料',
  no_data: '尚無任何經驗證的資料'
};

// 單一系列的完整流程：取得 → 解析 → 驗證 → 判定狀態 → 儲存。
// 任何一步失敗都不會產生新數值；只會更新狀態與原因，並保留上次成功的值（明確標示非最新）。
export async function runTaiex({ root = 'data', now = new Date(), fetchImpl = fetch, primaryUrl = META.sources.primary.url } = {}) {
  const started = isoTaipei(now);
  const seriesPath = join(root, 'series', META.id + '.json');
  const prev = await readJson(seriesPath, null);
  const raw_files = [];
  const log = { series: META.id, started_at: started, steps: [] };
  const step = (name, ok, detail) => { log.steps.push({ name, ok, detail }); };

  const base = {
    schema_version: 1, id: META.id, name: META.name, short_name: META.short_name, unit: META.unit,
    data_type: META.data_type, data_type_label: META.data_type_label, frequency: META.frequency, publisher: META.publisher,
    sources: META.sources, official_release_at: null, official_release_note: META.official_release_note, license_note: META.license_note,
    last_attempt_at: started
  };
  const keepPrev = (status, reason, extra = {}) => Object.assign({}, prev || {}, base, {
    status: prev && prev.value != null ? status : 'no_data', status_label: STATUS_LABEL[prev && prev.value != null ? status : 'no_data'],
    status_reason: reason, is_latest: false, last_success_at: prev ? prev.last_success_at || null : null
  }, extra);

  // 1. 取得（主要端點 + 交叉比對端點 + 休市日）
  let fm, mi, hol;
  try {
    fm = await fetchText(primaryUrl, { fetchImpl });
    raw_files.push({ name: 'FMTQIK', path: await saveRaw(root, META.id, started, 'FMTQIK', fm.text), ...fm.evidence });
    step('fetch_primary', true, fm.evidence);
  } catch (e) {
    step('fetch_primary', false, { error: e.message, ...(e.evidence || {}) });
    const rec = keepPrev('error', `無法連線證交所 OpenAPI：${e.message}`, { fetch_error: e.evidence || null });
    await writeJsonAtomic(seriesPath, rec);
    log.result = rec.status; log.reason = rec.status_reason;
    await appendRunLog(root, log);
    return { record: rec, log };
  }
  for (const [key, name] of [['cross_check', 'MI_INDEX'], ['calendar', 'holidaySchedule']]) {
    try {
      const r = await fetchText(META.sources[key].url, { fetchImpl });
      raw_files.push({ name, path: await saveRaw(root, META.id, started, name, r.text), ...r.evidence });
      if (key === 'cross_check') mi = r; else hol = r;
      step('fetch_' + name, true, r.evidence);
    } catch (e) { step('fetch_' + name, false, { error: e.message }); }
  }

  // 2. 解析（格式不符直接失敗，不猜測欄位）
  let rows, cross = null, holidays = [], calendarOk = !!hol;
  try {
    rows = parseFmtqik(JSON.parse(fm.text));
    if (mi) cross = parseMiIndex(JSON.parse(mi.text));
    if (hol) holidays = parseHolidays(JSON.parse(hol.text));
    step('parse', true, { rows: rows.length, cross: cross ? cross.date : null, holidays: holidays.length });
  } catch (e) {
    step('parse', false, { error: e.message });
    const rec = keepPrev('error', `官方回應格式不符，已停止更新：${e.message}`, { raw_files });
    await writeJsonAtomic(seriesPath, rec); log.result = rec.status; log.reason = rec.status_reason; await appendRunLog(root, log);
    return { record: rec, log };
  }

  // 3. 驗證
  const checks = validateTaiex({ rows, cross, now });
  if (!calendarOk) checks.push({ id: 'calendar', ok: true, detail: '無法取得休市日，僅以週末判斷交易日（已在狀態原因註明）' });
  const passed = checks.every((c) => c.ok);
  step('validate', passed, checks);
  if (!passed) {
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.id}：${c.detail}`).join('；');
    const rec = keepPrev('error', `驗證未通過，新資料不發布：${failed}`, { validation: { passed: false, checks }, raw_files });
    await writeJsonAtomic(seriesPath, rec); log.result = rec.status; log.reason = rec.status_reason; await appendRunLog(root, log);
    return { record: rec, log };
  }

  // 4. 判定狀態（依交易日曆與台北時間，不把舊資料當成最新）
  const last = rows[rows.length - 1], prevRow = rows[rows.length - 2] || null;
  const exp = expectedPeriod(now, holidays);
  let status, reason;
  if (last.date >= exp.expected) { status = 'ok'; reason = `最新收盤日 ${last.date}，即應有的最新交易日`; }
  else if (exp.waiting_for_today) { status = 'pending'; reason = `今日（${exp.expected}）為交易日，官方尚未在 OpenAPI 公布收盤；目前顯示 ${last.date} 的收盤`; }
  else { status = 'stale'; reason = `應有 ${exp.expected} 的收盤，但官方 OpenAPI 最新只到 ${last.date}`; }
  if (!calendarOk) reason += '（休市日資料取得失敗，交易日僅以週末判斷）';

  // 5. 儲存
  const samePeriod = prev && prev.period === last.date && prev.value === last.close;
  const first_seen_at = samePeriod ? prev.first_seen_at : started;
  const hist = await upsertHistory(join(root, 'history', META.id + '.json'), rows.map((r) => ({ period: r.date, value: r.close, change: r.change, trade_value: r.trade_value, first_seen_at: started })));
  const rec = Object.assign({}, base, {
    period: last.date, value: last.close, change: last.change,
    change_pct: prevRow ? Math.round((last.close / prevRow.close - 1) * 10000) / 100 : null,
    prev_period: prevRow ? prevRow.date : null, prev_value: prevRow ? prevRow.close : null,
    status, status_label: STATUS_LABEL[status], status_reason: reason, is_latest: status === 'ok',
    expected_period: exp.expected, first_seen_at, fetched_at: started, last_success_at: started,
    validation: { passed: true, checks }, raw_files, history_points: hist.points.length, revisions: hist.revisions.length
  });
  await writeJsonAtomic(seriesPath, rec);
  log.result = status; log.reason = reason; log.period = last.date; log.value = last.close;
  await appendRunLog(root, log);
  return { record: rec, log };
}

export async function writeManifest(root, records) {
  await writeJsonAtomic(join(root, 'manifest.json'), {
    generated_at: isoTaipei(new Date()),
    note: '所有頁面只讀這份清單與 series/*.json；數值皆經驗證流程產生，未通過驗證不會發布。',
    series: records.map((r) => ({ id: r.id, short_name: r.short_name, status: r.status, period: r.period || null, last_success_at: r.last_success_at || null, path: `series/${r.id}.json` }))
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.env.DATA_ROOT || 'data';
  // 故障演練：FAULT_INJECT=bad_host 時改連一個不存在的網域，用來在真實環境驗證錯誤處理
  const primaryUrl = process.env.FAULT_INJECT === 'bad_host' ? 'https://openapi.twse.invalid/v1/exchangeReport/FMTQIK' : undefined;
  const { record, log } = await runTaiex({ root, ...(primaryUrl ? { primaryUrl } : {}) });
  await writeManifest(root, [record]);
  console.log(JSON.stringify({ status: record.status, period: record.period, value: record.value, reason: record.status_reason, steps: log.steps.map((s) => `${s.name}:${s.ok ? 'ok' : 'FAIL'}`) }, null, 2));
  // 驗證或連線失敗時讓 Actions 顯示紅燈，但資料檔已寫入正確的錯誤狀態
  if (record.status === 'error' || record.status === 'no_data') process.exitCode = 1;
}
