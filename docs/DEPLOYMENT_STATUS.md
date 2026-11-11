# 部署狀態與待確認操作（2026-11-11）

## 實際狀態（GitHub API 查核）

| 項目 | 狀態 |
|---|---|
| 預設分支 | `gh-pages`（**未變更**） |
| `gh-pages` | 58770a8（11/10 部署），**未變更**；Pages 最後一次部署也是此 commit |
| `main` | 新建：程式、測試、排程 workflow `data-update.yml` |
| `data` | 新建 orphan 分支，與其他分支無共同歷史，只放已驗證資料；只由 Actions 機器人寫入 |
| `pipeline-test` | 保留，作為測試紀錄存檔 |
| 備份 | 全部分支的 git bundle 已存在本機輸出；遠端 tag 被代理拒絕（HTTP 403），未建立 |
| Actions 權限 | workflow 明確宣告 `contents: write`、`issues: write`。實測機器人可推送 data 分支、可開關 Issue |
| 無法以 API 讀取 | Pages 設定、Actions 預設權限、Secrets、協作者（代理回 403） |

## 待你確認的操作

| # | 操作 | 影響 | 回復方式 |
|---|---|---|---|
| 1 | **Settings → General → Default branch 改為 `main`**（必要） | `data-update.yml` 的排程開始生效，系統可無人值守更新；Repository 首頁改顯示 main 的 README；新 PR 預設基準改為 main。Pages 來源是明確指定的 `gh-pages`，不跟著預設分支變（請在改前、改後各截圖 Settings → Pages 確認） | 改回 `gh-pages`，排程立即停止 |
| 2 | Settings → Pages 確認來源為「Deploy from a branch：gh-pages /(root)」（只檢查，不修改） | 無 | — |
| 3 | 個人通知設定：Settings（個人）→ Notifications → Actions 勾選失敗通知（Email）；並 Watch 此 Repository 以收到 Issue 通知 | 異常會寄 Email | 取消勾選 |
| 4 | （選用）為 `gh-pages` 加上分支保護：禁止強制推送與刪除 | 防止誤刪正式網站分支；不影響 Pages 部署 | 刪除保護規則 |
