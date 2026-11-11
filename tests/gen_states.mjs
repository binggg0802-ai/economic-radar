// 產生五種狀態的實際管線輸出（用 fixture 模擬官方回應），給前端狀態測試使用。
import { readFile, mkdtemp, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTaiex } from '../pipeline/run.mjs';
const fx = (n) => readFile(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const mock = (map) => async (url) => { const k = Object.keys(map).find((x) => url.includes(x)); const v = k ? map[k] : null; if (v instanceof Error) throw v; return v == null ? { ok: false, status: 503, text: async () => 'down' } : { ok: true, status: 200, text: async () => v }; };
const good = { FMTQIK: await fx('FMTQIK.json'), MI_INDEX: await fx('MI_INDEX.json'), holidaySchedule: await fx('holidaySchedule.json') };
const out = 'preview/states'; await mkdir(out, { recursive: true });
const cases = [
  ['ok', '2026-11-10T16:00:00+08:00', good, false],
  ['pending', '2026-11-11T15:00:00+08:00', good, false],
  ['stale', '2026-11-12T09:05:00+08:00', good, false],
  ['error', '2026-11-11T16:00:00+08:00', { FMTQIK: new Error('ECONNRESET') }, true],
  ['no_data', '2026-11-10T16:00:00+08:00', {}, false]
];
for (const [name, when, map, seed] of cases) {
  const root = await mkdtemp(join(tmpdir(), 'st-'));
  if (seed) await runTaiex({ root, now: new Date('2026-11-10T16:00:00+08:00'), fetchImpl: mock(good) });
  const { record } = await runTaiex({ root, now: new Date(when), fetchImpl: mock(map) });
  await cp(join(root, 'series', 'tw_taiex.json'), join(out, name + '.json'));
  console.log(name, record.status, record.value ?? '-', record.status_reason);
}
