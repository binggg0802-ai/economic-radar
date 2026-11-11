import { readFile, writeFile, mkdir, appendFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

// 先寫暫存檔再改名，避免中途失敗留下半個檔案。
export async function writeJsonAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await rename(tmp, path);
}

export async function saveRaw(root, seriesId, stamp, name, text) {
  const p = join(root, 'raw', seriesId, stamp.slice(0, 10), `${stamp.slice(11, 16).replace(':', '')}-${name}.json`);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
  return p.slice(root.length + 1);
}

// 歷史資料：同一期間只保留一筆；若官方事後修正數值，保留修正紀錄而不是靜默覆蓋。
export async function upsertHistory(path, points) {
  const old = await readJson(path, { points: [] });
  const map = new Map(old.points.map((p) => [p.period, p]));
  const revisions = old.revisions || [];
  for (const p of points) {
    const prev = map.get(p.period);
    if (prev && prev.value !== p.value) revisions.push({ period: p.period, from: prev.value, to: p.value, detected_at: p.first_seen_at });
    if (!prev || prev.value !== p.value) map.set(p.period, Object.assign({}, p, prev ? { first_seen_at: prev.first_seen_at } : {}));
  }
  const points2 = [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
  await writeJsonAtomic(path, { points: points2, revisions });
  return { points: points2, revisions };
}

export async function appendRunLog(root, entry) {
  const p = join(root, 'runs', entry.started_at.slice(0, 7) + '.jsonl');
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + '\n');
  return p.slice(root.length + 1);
}
