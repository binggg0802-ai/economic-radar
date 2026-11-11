import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaiex } from '../pipeline/run.mjs';
import { rocToIso, toNumber } from '../pipeline/lib/util.mjs';
import { parseHolidays } from '../pipeline/sources/tw_taiex.mjs';
import { twCloseFreshness, decideTwRun } from '../pipeline/lib/schedule.mjs';

const fx = async (n) => readFile(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const at = (s) => new Date(s); // 傳入含 +08:00 的時間字串
function mockFetch(map) {
  return async (url) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    const v = key ? map[key] : null;
    if (v instanceof Error) throw v;
    if (v == null) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => v };
  };
}
async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'er-'));
  const map = { FMTQIK: await fx('FMTQIK.json'), MI_INDEX: await fx('MI_INDEX.json'), holidaySchedule: await fx('holidaySchedule.json'), ...overrides };
  return { root, fetchImpl: mockFetch(map) };
}

test('民國日期與數字解析：不合法就回傳 null，不猜', () => {
  assert.equal(rocToIso('1151110'), '2026-11-10');
  assert.equal(rocToIso('115/11/10'), '2026-11-10');
  assert.equal(rocToIso('1150230'), null);
  assert.equal(rocToIso('abc'), null);
  assert.equal(toNumber('42,711.92'), 42711.92);
  assert.equal(toNumber('--'), null);
  assert.equal(toNumber(''), null);
});

test('11/10 16:00 取得 → ok，數值與官方一致，記錄完整欄位', async () => {
  const { root, fetchImpl } = await setup();
  const { record } = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  assert.equal(record.status, 'ok');
  assert.equal(record.is_latest, true);
  assert.equal(record.period, '2026-11-10');
  assert.equal(record.value, 42711.92);
  assert.equal(record.change, 1050.22);
  assert.equal(record.change_pct, 2.52);
  assert.equal(record.unit, '點');
  assert.equal(record.data_type, 'close');
  assert.equal(record.official_release_at, null);
  assert.ok(record.official_release_note.includes('未提供'));
  for (const k of ['fetched_at', 'first_seen_at', 'last_success_at', 'last_attempt_at']) assert.match(record[k], /\+08:00$/);
  assert.equal(record.raw_files.length, 3);
  assert.ok(record.raw_files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.ok(record.validation.checks.find((c) => c.id === 'cross_check').ok);
  assert.ok(record.validation.checks.find((c) => c.id === 'change_consistent').ok);
});

test('隔天 11:00（開盤中）→ 應有的是前一交易日，狀態 ok', async () => {
  const { root, fetchImpl } = await setup();
  const { record } = await runTaiex({ root, now: at('2026-11-11T11:00:00+08:00'), fetchImpl });
  assert.equal(record.expected_period, '2026-11-10');
  assert.equal(record.status, 'ok');
});

test('隔天 15:00 官方尚未公布 → pending，且 is_latest=false', async () => {
  const { root, fetchImpl } = await setup();
  const { record } = await runTaiex({ root, now: at('2026-11-11T15:00:00+08:00'), fetchImpl });
  assert.equal(record.status, 'pending');
  assert.equal(record.is_latest, false);
  assert.equal(record.value, 42711.92);
  assert.match(record.status_reason, /尚未/);
});

test('隔天 19:00 官方仍未更新 → 仍是 pending（實測 OpenAPI 晚於 18:10 才更新，不提早判逾期）', async () => {
  const { root, fetchImpl } = await setup();
  const { record } = await runTaiex({ root, now: at('2026-11-11T19:00:00+08:00'), fetchImpl });
  assert.equal(record.status, 'pending');
  assert.equal(record.valid_until, '2026-11-12T09:00:00+08:00');
});

test('超過下一交易日 09:00 仍沒有 → stale（逾期），不冒充最新', async () => {
  const { root, fetchImpl } = await setup();
  const { record } = await runTaiex({ root, now: at('2026-11-12T09:05:00+08:00'), fetchImpl });
  assert.equal(record.status, 'stale');
  assert.equal(record.is_latest, false);
});

test('週末與休市日：期限順延到下一個交易日 09:00', () => {
  const hol = parseHolidays([{ Name: '測試休市', Date: '1151112', Description: '' }]);
  // 週五 11/13 收盤 → 下一交易日是週一 11/16；週末不算逾期
  assert.equal(twCloseFreshness('2026-11-13', at('2026-11-15T20:00:00+08:00'), []).state, 'ok');
  // 11/11 收盤，11/12 休市 → 期限順延到 11/13 09:00
  const f = twCloseFreshness('2026-11-10', at('2026-11-12T10:00:00+08:00'), hol);
  assert.equal(f.state, 'pending');
  assert.equal(f.deadline, '2026-11-13T09:00:00+08:00');
  // 「市場無交易，僅辦理結算交割作業」不算交易日
  const h2 = parseHolidays([{ Name: '市場無交易，僅辦理結算交割作業', Date: '1151112', Description: '' }]);
  assert.equal(twCloseFreshness('2026-11-11', at('2026-11-12T15:00:00+08:00'), h2).state, 'ok');
  assert.equal(decideTwRun(at('2026-11-12T15:00:00+08:00'), { value: 1, period: '2026-11-11', status: 'ok' }, h2).run, false);
});

test('漲跌點數與收盤不吻合 → 驗證失敗，不發布新值，保留上次成功值並標示非最新', async () => {
  const { root, fetchImpl } = await setup();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const bad = JSON.parse(await fx('FMTQIK.json'));
  bad.push({ Date: '1151111', TradeValue: '1', TAIEX: '43000.00', Change: '999.99' });
  const f2 = mockFetch({ FMTQIK: JSON.stringify(bad), MI_INDEX: await fx('MI_INDEX.json'), holidaySchedule: await fx('holidaySchedule.json') });
  const { record } = await runTaiex({ root, now: at('2026-11-11T16:00:00+08:00'), fetchImpl: f2 });
  assert.equal(record.status, 'source_anomaly');
  assert.equal(record.is_latest, false);
  assert.equal(record.value, 42711.92);
  assert.equal(record.period, '2026-11-10');
  assert.match(record.status_reason, /change_consistent/);
});

test('單日變動超過 10% → 驗證失敗', async () => {
  const rows = JSON.parse(await fx('FMTQIK.json'));
  rows.push({ Date: '1151111', TradeValue: '1', TAIEX: '48000.00', Change: '5288.08' });
  const { root, fetchImpl } = await setup({ FMTQIK: JSON.stringify(rows) });
  const { record } = await runTaiex({ root, now: at('2026-11-11T16:00:00+08:00'), fetchImpl });
  assert.equal(record.status, 'no_data');
  assert.match(record.status_reason, /daily_move_sane/);
});

test('交叉比對端點數字不同 → 驗證失敗', async () => {
  const mi = JSON.parse(await fx('MI_INDEX.json')); mi[1]['收盤指數'] = '42711.93';
  const { root, fetchImpl } = await setup({ MI_INDEX: JSON.stringify(mi) });
  const { record } = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  assert.equal(record.status, 'no_data');
  assert.match(record.status_reason, /cross_check/);
});

test('連線失敗 → error，保留上次成功值與時間，不產生新數字', async () => {
  const { root, fetchImpl } = await setup();
  const ok = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const { record } = await runTaiex({ root, now: at('2026-11-11T16:00:00+08:00'), fetchImpl: mockFetch({ FMTQIK: new Error('ECONNRESET') }) });
  assert.equal(record.status, 'error');
  assert.equal(record.value, 42711.92);
  assert.equal(record.last_success_at, ok.record.last_success_at);
  assert.equal(record.is_latest, false);
});

test('從未成功且連線失敗 → no_data（前端不得顯示任何數字）', async () => {
  const { root } = await setup();
  const { record } = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl: mockFetch({}) });
  assert.equal(record.status, 'no_data');
  assert.equal(record.value, null);
  assert.equal(record.period, null);
});

test('官方欄位格式改變 → error，不猜欄位', async () => {
  const { root, fetchImpl } = await setup({ FMTQIK: JSON.stringify([{ date: '2026-11-10', close: 1 }]) });
  const { record } = await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  assert.equal(record.status, 'no_data');
  assert.match(record.status_reason, /格式不符/);
});

test('官方事後修正數值 → 保留修正紀錄', async () => {
  const { root, fetchImpl } = await setup();
  await runTaiex({ root, now: at('2026-11-10T16:00:00+08:00'), fetchImpl });
  const rows = JSON.parse(await fx('FMTQIK.json')); rows[4].TAIEX = '42711.95'; rows[4].Change = '1050.25';
  const mi = JSON.parse(await fx('MI_INDEX.json')); mi[1]['收盤指數'] = '42711.95'; mi[1]['漲跌點數'] = '1050.25';
  const f2 = mockFetch({ FMTQIK: JSON.stringify(rows), MI_INDEX: JSON.stringify(mi), holidaySchedule: await fx('holidaySchedule.json') });
  const { record } = await runTaiex({ root, now: at('2026-11-10T17:00:00+08:00'), fetchImpl: f2, force: true });
  assert.equal(record.revisions, 1);
  assert.equal(record.data_version, 2);
  const hist = JSON.parse(await readFile(join(root, 'history', 'tw_taiex.json'), 'utf8'));
  assert.deepEqual(hist.revisions[0].from, 42711.92);
});
