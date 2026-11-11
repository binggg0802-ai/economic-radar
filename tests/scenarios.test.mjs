// 八個情境測試（對應需求第 6 點），全部使用官方真實回應的 fixture，不連網。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaiex, writeManifest } from '../pipeline/run.mjs';
import { decideScheduledRelease, zonedToUtc } from '../pipeline/lib/schedule.mjs';

const fx = async (n) => readFile(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const at = (s) => new Date(s);
const J = async (p) => JSON.parse(await readFile(p, 'utf8'));
function mockFetch(map) {
  return async (url) => {
    if (url.includes('.invalid')) { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
    const key = Object.keys(map).find((k) => url.includes(k));
    const v = key ? map[key] : null;
    if (v instanceof Error) throw v;
    if (v == null) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => v };
  };
}
async function env() {
  const root = await mkdtemp(join(tmpdir(), 'er2-'));
  const fetchImpl = mockFetch({ FMTQIK: await fx('FMTQIK.json'), MI_INDEX: await fx('MI_INDEX.json'), holidaySchedule: await fx('holidaySchedule.json') });
  return { root, fetchImpl };
}

test('S1 正常公布：11/10 16:00 取得當日收盤 → 已更新，schema v2 欄位齊全', async () => {
  const { root, fetchImpl } = await env();
  const { record: r, log } = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  assert.equal(log.result, 'ok');
  assert.equal(r.status_label, '已更新');
  for (const k of ['code', 'name', 'value', 'unit', 'period', 'source', 'raw_url', 'first_seen_at', 'last_success_at', 'verification', 'data_version'])
    assert.ok(r[k] !== undefined && r[k] !== null, '缺少欄位 ' + k);
  assert.equal(r.schema_version, 2);
  assert.equal(r.code, 'tw_taiex');
  assert.equal(r.value, 42711.92);
  assert.equal(r.period, '2026-11-10');
  assert.equal(r.verification.status, 'verified');
  assert.equal(r.data_version, 1);
  assert.equal(r.valid_until, '2026-11-12T09:00:00+08:00');
  assert.equal(r.license.status, '待確認');
});

test('S2 尚未公布：11/11 15:00 官方只到 11/10 → 尚未公布，不標最新', async () => {
  const { root, fetchImpl } = await env();
  const { record: r } = await runTaiex({ root, now: at('2026-11-11T15:00:00+08:00'), fetchImpl });
  assert.equal(r.status, 'pending');
  assert.equal(r.status_label, '尚未公布');
  assert.equal(r.is_latest, false);
  assert.equal(r.period, '2026-11-10');
});

test('S3 API 中斷（網域無法解析／HTTP 500）→ 更新失敗，保留上次成功值與原日期', async () => {
  const { root, fetchImpl } = await env();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const a = await runTaiex({ root, now: at('2026-11-11T16:00:00+08:00'), fetchImpl, fault: 'bad_host' });
  assert.equal(a.record.status, 'error');
  assert.equal(a.record.status_label, '更新失敗');
  assert.equal(a.record.value, 42711.92);
  assert.equal(a.record.period, '2026-11-10');
  assert.equal(a.record.is_latest, false);
  assert.match(a.record.status_reason, /ENOTFOUND/);
  const b = await runTaiex({ root, now: at('2026-11-11T16:20:00+08:00'), fetchImpl, fault: 'http_500' });
  assert.equal(b.record.status, 'error');
  assert.match(b.record.status_reason, /500/);
  const m = await J(join(root, 'monitor', 'status.json'));
  assert.equal(m.series.tw_taiex.consecutive_failures, 2);
  assert.equal(m.series.tw_taiex.source_health.FMTQIK.ok, false);
});

test('S4 格式改變（欄位改名）→ 來源異常，不猜欄位，不發布', async () => {
  const { root, fetchImpl } = await env();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const { record: r } = await runTaiex({ root, now: at('2026-11-11T16:00:00+08:00'), fetchImpl, fault: 'format_change' });
  assert.equal(r.status, 'source_anomaly');
  assert.equal(r.status_label, '來源異常');
  assert.equal(r.retained_freshness.state, 'pending'); // 保留的 11/10 在 11/11 收盤公布前仍屬等待中
  assert.match(r.status_reason, /格式不符/);
  assert.equal(r.value, 42711.92);
  assert.equal(r.data_version, 1);
});

test('S5 重複執行：排程自動略過；強制重跑也不改版本、不重複存原始檔', async () => {
  const { root, fetchImpl } = await env();
  const first = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const skip = await runTaiex({ root, now: at('2026-11-10T16:20:00+08:00'), fetchImpl });
  assert.equal(skip.log.result, 'skipped');
  assert.match(skip.log.reason, /無新的交易日收盤待取得/);
  const again = await runTaiex({ root, now: at('2026-11-10T16:40:00+08:00'), fetchImpl, force: true });
  assert.equal(again.record.data_version, 1);
  assert.equal(again.record.first_seen_at, first.record.first_seen_at);
  assert.ok(again.record.raw_files.every((f) => f.deduplicated));
  const files = await readdir(join(root, 'raw', 'tw_taiex', '2026-11-10'));
  assert.equal(files.length, 3); // 只有第一次的三個檔案
  const hist = await J(join(root, 'history', 'tw_taiex.json'));
  assert.equal(hist.revisions.length, 0);
});

test('S6 非交易日：週六取得週五收盤 → 已更新；週日排程略過，不連線', async () => {
  const { root, fetchImpl } = await env();
  // old_data 故障讓官方回應停在 11/6（週五），模擬週末時官方最新資料
  const sat = await runTaiex({ root, now: at('2026-11-07T15:00:00+08:00'), fetchImpl, fault: 'old_data' });
  assert.equal(sat.record.period, '2026-11-06');
  assert.equal(sat.record.status, 'ok');
  assert.equal(sat.record.expected_period, '2026-11-06');
  assert.equal(sat.record.next_due_period, '2026-11-09');
  let calls = 0;
  const counting = async (...a) => { calls++; return fetchImpl(...a); };
  const sun = await runTaiex({ root, now: at('2026-11-08T15:00:00+08:00'), fetchImpl: counting });
  assert.equal(sun.log.result, 'skipped');
  assert.match(sun.log.reason, /無新的交易日收盤待取得.*2026-11-09 尚未收盤/);
  assert.equal(calls, 0);
  assert.equal(sat.record.valid_until, '2026-11-10T09:00:00+08:00');
});

test('S7 舊資料不得覆蓋新資料：官方端點回傳較舊日期 → 保留較新的值', async () => {
  const { root, fetchImpl } = await env();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const { record: r, log } = await runTaiex({ root, now: at('2026-11-10T17:00:00+08:00'), fetchImpl, fault: 'old_data', force: true });
  assert.equal(log.result, 'source_anomaly');
  assert.equal(r.status_label, '來源異常');
  assert.equal(r.is_latest, false);
  assert.equal(r.period, '2026-11-10');
  assert.equal(r.value, 42711.92);
  assert.equal(r.data_version, 1);
  assert.match(r.last_guard.reason, /早於已保存/);
  // 演練用的竄改回應不得混入官方原始資料
  const inj = await readdir(join(root, 'raw', 'tw_taiex', '_fault_injected', '2026-11-10'));
  assert.deepEqual(inj, ['170000-FMTQIK.old_data.json']);
  const idx = await J(join(root, 'raw', 'tw_taiex', 'latest.json'));
  assert.ok(!idx.FMTQIK.path.includes('_fault'));
});

test('S8 失敗後恢復：連續失敗 → 正常 → 已更新，失敗計數歸零，監控記錄前後值', async () => {
  const { root, fetchImpl } = await env();
  await runTaiex({ root, now: at('2026-11-10T14:10:00+08:00'), fetchImpl, fault: 'bad_host' });
  await runTaiex({ root, now: at('2026-11-10T14:30:00+08:00'), fetchImpl, fault: 'bad_host' });
  let m = await J(join(root, 'monitor', 'status.json'));
  assert.equal(m.series.tw_taiex.last_result, 'no_data'); // 從未成功取得
  assert.equal(m.series.tw_taiex.consecutive_failures, 2);
  const ok = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  assert.equal(ok.record.status, 'ok');
  m = await J(join(root, 'monitor', 'status.json'));
  assert.equal(m.series.tw_taiex.consecutive_failures, 0);
  assert.equal(m.series.tw_taiex.last_change.before.status, 'no_data');
  assert.equal(m.series.tw_taiex.last_change.after.value, 42711.92);
  assert.equal(m.recent_runs.length, 3);
  const runs = (await readFile(join(root, 'runs', '2026-11.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(runs.map((x) => x.result), ['no_data', 'no_data', 'ok']);
});

test('清單：四個指標都在，未接入的沒有任何數值', async () => {
  const { root, fetchImpl } = await env();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  await writeManifest(root);
  const man = await J(join(root, 'manifest.json'));
  assert.deepEqual(man.series.map((s) => s.code), ['tw_taiex', 'usd_twd', 'tw_cpi', 'us_cpi']);
  for (const s of man.series.slice(1)) { assert.equal(s.status, 'not_connected'); assert.equal(s.value, null); }
});

test('排程：BLS 依官方日程與美東時區；主計總處日程未核對 → 不排程', async () => {
  const bls = JSON.parse(await readFile(new URL('../pipeline/calendars/bls_cpi.json', import.meta.url), 'utf8'));
  const dg = JSON.parse(await readFile(new URL('../pipeline/calendars/dgbas_cpi.json', import.meta.url), 'utf8'));
  // 2026-12-10 08:30 EST = 13:30Z = 台北 21:30
  assert.equal(zonedToUtc('2026-12-10', '08:30', 'America/New_York').toISOString(), '2026-12-10T13:30:00.000Z');
  // 夏令時間：08:30 EDT = 12:30Z
  assert.equal(zonedToUtc('2026-07-14', '08:30', 'America/New_York').toISOString(), '2026-07-14T12:30:00.000Z');
  assert.equal(decideScheduledRelease(at('2026-12-10T21:20:00+08:00'), null, bls).run, false); // 公布前
  const d = decideScheduledRelease(at('2026-12-10T21:40:00+08:00'), null, bls);
  assert.equal(d.run, true);
  assert.match(d.reason, /2026-11/);
  assert.equal(decideScheduledRelease(at('2026-12-10T21:40:00+08:00'), { period: '2026-11', status: 'ok' }, bls).run, false);
  assert.equal(decideScheduledRelease(at('2026-12-06T16:30:00+08:00'), null, dg).run, false);
});

test('通知：連續 3 次更新失敗才發警示（避免偶發斷線洗版）；資料逾期立即警示；恢復後解除', async () => {
  const { root, fetchImpl } = await env();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const M = async () => (await J(join(root, 'monitor', 'status.json'))).series.tw_taiex;
  for (const [i, t] of ['14:10', '14:30', '14:50'].entries()) {
    await runTaiex({ root, now: at(`2026-11-11T${t}:00+08:00`), fetchImpl, fault: 'bad_host' });
    const s = await M();
    if (i < 2) assert.equal(s.alert, null); else { assert.match(s.alert, /連續 3 次失敗/); assert.equal(s.alert_changed, true); }
  }
  // 恢復：官方仍只有 11/10、隔天 09:05 → 資料逾期，警示內容改變
  const st = await runTaiex({ root, now: at('2026-11-12T09:05:00+08:00'), fetchImpl });
  assert.equal(st.record.status, 'stale');
  assert.equal(st.record.value, 42711.92);
  assert.match((await M()).alert, /資料逾期/);
  // 同樣狀態再跑一次：警示不變，不重複通知
  await runTaiex({ root, now: at('2026-11-12T09:35:00+08:00'), fetchImpl });
  assert.equal((await M()).alert_changed, false);
});
