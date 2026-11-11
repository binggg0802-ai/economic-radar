# 經濟雷達 已驗證資料（data 分支）

只由 GitHub Actions（`main` 分支的 `.github/workflows/data-update.yml`）寫入，請勿手動修改。

| 路徑 | 內容 |
|---|---|
| `manifest.json` | 所有指標清單與目前狀態；前端唯一入口 |
| `series/<code>.json` | 單一指標的最新驗證結果（schema v2） |
| `history/<code>.json` | 歷史數值與官方修正紀錄 |
| `raw/<code>/` | 官方原始回應存證（含 sha256） |
| `runs/YYYY-MM.jsonl` | 每次執行紀錄（含被排程略過的） |
| `monitor/status.json` | 監控摘要：連續失敗、來源健康度、警示 |
| `calendars/` | 證交所休市日表快取 |

初始內容：2026-11-11 由 `pipeline-test` 分支複製，已移除故障演練用的竄改回應。
`runs/` 與 `monitor/` 保留了當天的測試紀錄，有 fault 欄位的就是演練。
