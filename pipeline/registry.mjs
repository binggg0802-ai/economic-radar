// 指標清單：所有頁面（首頁／雷達／市場／新聞／報告）只能讀這裡列出、且經驗證流程產生的資料。
// active=false 的指標「尚未接入」：不會有數值，前端只能顯示「尚未接入」，不得用寫死的數字代替。
export const REGISTRY = [
  {
    code: 'tw_taiex', name: '台灣加權指數', unit: '點', active: true,
    data_type: 'close', frequency: '每個交易日（收盤後）',
    publisher: '臺灣證券交易所', source_url: 'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',
    schedule: '交易日 14:07 起每 20 分鐘檢查，取得當日收盤即停止；非交易日不抓取',
    license: { status: '待確認', note: '政府資料開放平臺將此資料集（每日市場成交資訊，data.gov.tw/datasets/11672）標示為政府資料開放授權條款第 1 版、免費；但證交所網站使用條款與交易資訊使用管理辦法是否另有限制，尚待證交所書面確認。' }
  },
  {
    code: 'usd_twd', name: '美元／新台幣 收盤匯率', unit: '新台幣／美元', active: false,
    data_type: 'close', frequency: '每個營業日（約 16:00–17:00 公布）',
    publisher: '中央銀行', source_url: 'https://cpx.cbc.gov.tw/api/OpenData/FTDOpenData_Day',
    schedule: '尚未接入。規劃：營業日 16:17 起檢查，取得即停止',
    license: { status: '可用（需標示來源）', note: '政府資料開放授權條款第 1 版。' }
  },
  {
    code: 'tw_cpi', name: '台灣消費者物價指數（CPI）年增率', unit: '%', active: false,
    data_type: 'periodic', frequency: '每月一次（依主計總處預告日程）',
    publisher: '行政院主計總處', source_url: 'https://www.stat.gov.tw/',
    schedule: '尚未接入。官方預告日程尚未核對，排程器不會猜測發布日',
    license: { status: '可用（需標示來源）', note: '政府資料開放授權條款第 1 版。' }
  },
  {
    code: 'us_cpi', name: '美國消費者物價指數（CPI-U）', unit: '指數／%', active: false,
    data_type: 'periodic', frequency: '每月一次（依 BLS 公布日程，美東 08:30）',
    publisher: 'U.S. Bureau of Labor Statistics', source_url: 'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0',
    schedule: '尚未接入。BLS 日程已建檔（pipeline/calendars/bls_cpi.json），排程判斷已實作並測試',
    license: { status: '可用（公有領域，建議標示來源）', note: 'BLS 資料屬美國聯邦政府公有領域；API v1 無金鑰，每日 25 次查詢上限。' }
  }
];
