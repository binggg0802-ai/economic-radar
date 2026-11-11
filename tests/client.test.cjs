const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyDisplayStatus } = require('../client/radar-data.js');
const rec = { code: 'tw_taiex', value: 42711.92, period: '2026-11-10', status: 'ok', valid_until: '2026-11-11T18:00:00+08:00', status_reason: 'x' };
test('前端：有效期限內維持已更新', () => {
  const r = applyDisplayStatus(rec, new Date('2026-11-11T17:59:00+08:00'));
  assert.equal(r.display_status, 'ok'); assert.equal(r.display_is_latest, true);
});
test('前端：排程停擺、超過有效期限 → 資料逾期，不標最新，但保留原日期', () => {
  const r = applyDisplayStatus(rec, new Date('2026-11-11T18:01:00+08:00'));
  assert.equal(r.display_status, 'stale'); assert.equal(r.display_label, '資料逾期');
  assert.equal(r.display_is_latest, false); assert.equal(r.period, '2026-11-10'); assert.match(r.display_reason, /2026-11-10/);
});
test('前端：從未成功取得／尚未接入 → 不給數字', () => {
  assert.equal(applyDisplayStatus({ status: 'no_data', value: 1 }).value, null);
  assert.equal(applyDisplayStatus({ status: 'not_connected', value: null }).display_label, '尚未接入');
});
