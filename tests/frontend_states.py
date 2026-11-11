# 前端狀態測試：用管線實際輸出的五種狀態檔載入測試頁，檢查畫面是否誠實呈現。
import asyncio, sys, json
from playwright.async_api import async_playwright
BASE = sys.argv[1]
EXPECT = {
  'ok':      dict(value=True,  notlatest=False, nodata=False, badge='已更新'),
  'pending': dict(value=True,  notlatest=True,  nodata=False, badge='尚未公布'),
  'stale':   dict(value=True,  notlatest=True,  nodata=False, badge='逾期'),
  'error':   dict(value=True,  notlatest=True,  nodata=False, badge='更新失敗'),
  'no_data': dict(value=False, notlatest=False, nodata=True,  badge='尚無'),
}
async def main():
    res = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 390, 'height': 844})
        for name, e in EXPECT.items():
            await pg.goto(f'{BASE}/preview/index.html?src=states/{name}.json'); await pg.wait_for_timeout(400)
            got = dict(value=await pg.locator('[data-testid=value]').count() == 1, notlatest=await pg.locator('[data-testid=notlatest]').count() == 1, nodata=await pg.locator('[data-testid=nodata]').count() == 1)
            badge = await pg.locator('[data-status]').inner_text()
            ok = all(got[k] == e[k] for k in got) and e['badge'] in badge
            res.append((ok, name, got, badge)); await pg.screenshot(path=f'preview/states/{name}.png', full_page=True)
        await pg.goto(f'{BASE}/preview/index.html?src=states/missing.json'); await pg.wait_for_timeout(400)
        t = await pg.inner_text('body'); ok = '無法取得資料檔' in t and await pg.locator('[data-testid=value]').count() == 0
        res.append((ok, 'file_missing', {}, '')); 
        await b.close()
    for ok, n, g, bd in res: print(('PASS' if ok else 'FAIL'), n, g, bd)
    print('TOTAL', len(res), 'FAIL', sum(1 for r in res if not r[0]))
asyncio.run(main())
