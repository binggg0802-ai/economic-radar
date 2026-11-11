# 分支與資料儲存方案（待確認，尚未執行）

> 本文件只是提案。目前沒有建立 `main`、沒有建立 `data` 分支、沒有調整 `gh-pages`，也沒有更改預設分支或 Pages 設定。

## 1. 現況（2026-11-11 查核）

| 項目 | 現況 | 查核方式 |
|---|---|---|
| Repository | `binggg0802-ai/economic-radar`，公開 | GitHub API |
| 預設分支 | `gh-pages` | GitHub API |
| 分支 | `gh-pages`（正式網站）、`pipeline-test`（本次測試） | GitHub API |
| `gh-pages` 保護規則 | 無 | GitHub API |
| Pages 部署來源 | `pages-build-deployment` 工作流程存在，代表由分支自動部署（classic） | 工作流程清單 |
| Pages 來源分支與資料夾、Actions 寫入權限、Secrets | **無法以 API 讀取**（代理回 403） | 需要你在 Settings 確認 |
| Actions 寫入 | `pipeline-test` 上的 bot 已能 push，代表 Workflow 有 contents: write | 實際執行紀錄 |
| App／後端原始碼 | **不在 GitHub 上**，只存在本機資料夾。內含 `app/.env`（已被 gitignore） | 本機檢查 |

### 核心問題

GitHub Actions 的 `schedule` 只在**預設分支**觸發。目前預設分支是正式網站 `gh-pages`。

- 不改分支：排程永遠不會自動執行，只能手動或推送觸發。
- 把 workflow 和資料放進 `gh-pages`：每次資料更新都會觸發正式網站重新部署。網站程式碼也會和機器人提交混在一起，違反「網站程式與資料更新分離」。

## 2. 建議方案（A）

```
main     ← 新建，設為預設分支。只放程式：pipeline/、client/、tests/、.github/workflows/、docs/
data     ← 新建（orphan，無共同歷史）。只放機器人產生的 data/，所有自動提交只進這裡
gh-pages ← 不動。正式網站維持原樣，直到你另外確認前端改版
```

### 執行步驟（每一步都可單獨回復）

1. **秘密掃描**：對要放進 `main` 的檔案執行 gitleaks 或同等掃描。確認沒有 API 金鑰、`.env`、Supabase service key。App／後端原始碼這一步**不放**。
2. 由 `pipeline-test` 的程式部分（不含 `data/`）建立 `main`。
3. 建立 orphan `data` 分支，放入目前已驗證的 `data/`（台灣加權指數 11/10 收盤與執行紀錄）。
4. 修改 workflow：checkout `main` 執行程式，另外 checkout `data` 讀寫資料，只 push 到 `data`。
5. 在 Settings → General 把預設分支改為 `main`。這一步需要你操作或授權，API 被代理擋住。
6. 觀察 1～2 個交易日的排程紀錄（`data/monitor/status.json`），確認自動更新後，才討論前端怎麼讀資料（見第 4 節）。

### 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 改預設分支後，Pages 來源意外改變 | 正式網站中斷 | Pages 來源是明確指定的分支，不跟著預設分支變。執行前請你在 Settings → Pages 截圖確認來源是 `gh-pages`，改完再確認一次 |
| 公開 Repository 外洩金鑰 | 金鑰被濫用 | 步驟 1 掃描。這條管線不需要任何金鑰：證交所 OpenAPI、BLS v1、央行 OpenData 都免金鑰 |
| GitHub 排程延遲或漏跑 | 資料晚更新 | 每 20 分鐘一次、避開整點。前端用 `valid_until` 判斷逾期，漏跑會顯示「資料逾期」，不會誤標最新 |
| 公開 Repository 60 天無活動，排程會被停用 | 自動更新停止 | `data` 分支每個交易日都有機器人提交。是否計入「活動」**待確認**；監控頁會顯示最後執行時間，停擺可被看見 |
| 已設定的分支預設值改變 | 新 clone、PR 的預設基準改為 `main` | 目前沒有其他協作者，影響小 |

### 回復方式

- 預設分支：Settings → General → Default branch 改回 `gh-pages`。
- 刪除新分支：`git push origin --delete main data`。
- 正式網站：整個過程不改 `gh-pages` 與 Pages 設定，不需要回復。

## 3. 替代方案

| 方案 | 優點 | 缺點 |
|---|---|---|
| B. 全部放在 `gh-pages` | 不用改預設分支 | 程式、資料、網站混在一起；每次更新都重新部署正式網站。不建議 |
| C. 用既有 Supabase pg_cron 定時呼叫 GitHub `workflow_dispatch` | 不用改預設分支 | 需要在 Supabase 存一把 GitHub token（多一個秘密），而且會動到後端。先前要求不修改後端，需你另外確認 |
| D. 另開一個專門放資料管線的 Repository（設為其預設分支） | 與網站完全隔離 | 多一個 Repository 要管理；前端跨 Repository 讀資料 |

## 4. 前端如何讀資料（下一階段，另行確認）

| 做法 | 說明 |
|---|---|
| 4a. 讀 `data` 分支 | 前端讀 `https://raw.githubusercontent.com/binggg0802-ai/economic-radar/data/data/manifest.json`。有約 5 分鐘快取，不影響正式網站部署 |
| 4b. 改用 Actions 部署 Pages（建議） | 把 `gh-pages` 的網站與 `data` 分支的最新快照合併後發布。屬於正式網站部署方式的變更，必須另外確認 |

不論哪種做法，所有頁面都只透過 `client/radar-data.js` 取數字。
