# Fork 作業筆記

> Fork 自有文件。這份文件記錄 fork 與上游 Shinkansen 的差異：授權隔離、作業規範、上游核心檔的每一處掛鉤，以及如何同步上游。
> 每個階段的 PR 都必須更新本檔的 §4 掛鉤清單。

- 上游：[jimmysu0309/shinkansen](https://github.com/jimmysu0309/shinkansen)（Elastic License 2.0）
- Fork 起點：上游 v2.6.4，commit `4ebf220`
- 擴充功能新名稱：**暫名：＿＿＿**（待定，見 GAP-ANALYSIS §6）

## 1. 授權

- 根目錄 `LICENSE`（ELv2，Copyright 2026 Jimmy Su）**不得修改或刪除**。上游所有版權與授權聲明（`LICENSE`、`shinkansen/THIRD-PARTY-NOTICES.md`、`shinkansen/lib/readability.LICENSE`、`shinkansen/lib/vendor/**/LICENSE*`、原始碼內的版權註解）一律保留。
- Fork 引入的第三方套件，只能是寬鬆授權（MIT、Apache-2.0、BSD 等），並且**加在既有的 `shinkansen/THIRD-PARTY-NOTICES.md`**，沿用該檔的欄位格式：用途、檔案、來源與版本、授權、授權檔位置。不另開一份 notices 檔。
- 授權檔跟著 vendored 檔案放（例如 `shinkansen/fork/vendor/<套件>/LICENSE`）。

## 2. 授權隔離紀錄（clean-room log）

規則：**禁止複製** FluentRead、Read Frog、MangoTL 或任何 GPL / AGPL 專案的程式碼（改寫變數名稱後貼上也不行）。只能閱讀 README、使用指南、截圖，用來理解「功能行為」，再依 Shinkansen 的架構自行實作。

| 日期 | 對象 | 讀了什麼 | 沒有讀什麼 |
|---|---|---|---|
| 2026-11-09 | FluentRead（GPL-3.0，[FluentRead/FluentRead](https://github.com/FluentRead/FluentRead)） | 1. `README.md`：透過 GitHub contents API 只下載這一個檔案。API 的根目錄清單會順帶顯示根目錄檔名，但沒有開啟其他任何檔案。<br>2. 使用指南 [read.thinkstu.com/en/](https://read.thinkstu.com/en/) 的 35 頁（清單見 GAP-ANALYSIS §1），轉成純文字後閱讀 | 任何原始碼、設定檔、樣式表、測試、`src/` 等目錄 |
| 2026-11-09 | Read Frog（[mengxi-ream/read-frog](https://github.com/mengxi-ream/read-frog)） | 沒有讀（只在 FluentRead 的 README 看到連結） | 全部 |
| 2026-11-09 | MangoTL | 沒有讀 | 全部 |

往後各階段若需要再查 FluentRead 的行為，**只能讀使用指南與截圖**，並在上表新增一列。

實作者自律：
- 寫 fork 程式碼時，不開啟上述專案的原始碼（包括 GitHub 網頁瀏覽）。
- 演算法採用公開的通用做法，在程式註解中寫明出處（例如 SM-2、Anki 匯入格式、Gemini 官方文件）。

## 3. 作業規範

### 3.1 目錄與命名

| 項目 | 規範 |
|---|---|
| 程式碼位置 | `shinkansen/fork/`（擴充功能根目錄維持 `shinkansen/`，避免合併上游時整個目錄衝突） |
| 背景端 | `shinkansen/fork/bg/index.js` 為入口，`background.js` 只 import 這一支 |
| Content 端 | `shinkansen/fork/content/*.js`，加在 manifest `content_scripts` 清單的最後 |
| 擴充頁面 | `shinkansen/fork/pages/<功能>/`（例如學習中心、翻譯中心） |
| Offscreen 文件 | `shinkansen/fork/offscreen/`（第 5、6 階段） |
| 訊息類型 | 一律加 `FORK_` 前綴，由 fork 自己的 `runtime.onMessage` listener 處理；上游的 router 遇到未知類型時不回應，不會衝突 |
| 設定 | 同步設定集中在 `DEFAULT_SETTINGS.fork` 子物件；機密（API key、WebDAV 密碼）放 `storage.local`，key 名稱用 `fork` 前綴 |
| 大型資料 | IndexedDB，資料庫名稱用 `fork-` 前綴（學習中心、TTS 音訊快取、漫畫快取） |
| 內部識別字 | 上游的 CSS class、`<shinkansen-translation>`、storage key、DB 名稱**一律不改名**；只改使用者看得到的名稱 |
| 介面字串 | 沿用 `lib/i18n.js` 的 8 種語言機制；fork 的字串放 `shinkansen/fork/i18n/`，並註冊進同一個 `t()` |
| 模型 ID 與價格 | 只寫在 `lib/model-pricing.js`（計價）與 `DEFAULT_SETTINGS.fork`（選用模型）。其他地方一律從這兩處讀，不寫死預覽模型名稱 |

### 3.2 上游原則（fork 同樣遵守）

- 中文用語偏好交給 prompt，**不做譯後 regex 取代**。
- 資料只送往使用者選擇的服務。
- 所有 Gemini REST 請求的 key 放在 `x-goog-api-key` header，不放 URL。Live API 的 WebSocket 例外處理見 GAP-ANALYSIS §5.3 R-3，待你決定。
- 不新增自架後端、帳號系統或分析追蹤。
- 上游已有的功能保留上游版本，只補不足之處，不做第二套。
- 不改變上游功能的預設行為。fork 新增的行為一律預設關閉，或只在 fork 新增的入口生效。

### 3.3 分支、PR 與文件

- 一個階段一個分支：`phase-<N>/<簡短名稱>`，例如 `phase-0/gap-analysis`、`phase-1/engines`。
- PR 一律開在 fork 內：`gh pr create --repo yongjer/shinkansen --base main`。gh 預設會開到上游，**不要開到 jimmysu0309/shinkansen**。
- 每個階段的 PR 都要：
  - 更新 `SPEC.md` 的 fork 章節（從第 1 階段起新增，上游章節不動）。
  - 更新 `CHANGELOG.md`。
  - 更新本檔 §4。
  - 附上新功能的測試，以及「載入未封裝擴充功能的步驟、已知限制、manifest 權限變更」說明。
- 第 0 階段只新增文件，不改 SPEC.md 與 CHANGELOG.md。

### 3.4 測試

- 上游測試自 2026-08-06 起移到私有 repo（`.gitignore` 第 62–66 行），公開 repo 沒有測試。處理方式待你決定（GAP-ANALYSIS §6 決定 2）。
- Fork 自己的測試放獨立目錄，沿用上游的框架：jest（`*.test.cjs`、`testEnvironment: 'node'`、自建 jsdom）與 Playwright（載入未封裝擴充功能）。不和上游的 `test/` 混在一起。
- 新引擎一律附 mock 回應的單元測試，不打真實 API。

## 4. 上游核心檔的掛鉤清單

每一處對上游檔案的修改都記在這裡，方便合併上游時檢查。

| 階段 | 檔案 | 位置 | 修改內容 | 原因 |
|---|---|---|---|---|
| 0 | — | — | 沒有修改任何上游檔案（只新增 `docs/ARCHITECTURE-SUMMARY.md`、`docs/GAP-ANALYSIS.md`、`docs/FORK-NOTES.md`） | — |

預計的掛鉤點見 ARCHITECTURE-SUMMARY §10。

## 5. 同步上游

```bash
# 只需要做一次
git remote add upstream https://github.com/jimmysu0309/shinkansen.git

# 每次同步
git fetch upstream --tags
git switch main
git merge upstream/main          # 用 merge，不 rebase，保留各階段 PR 的歷史
# 有衝突時：先對照 §4 的掛鉤清單，衝突應該只出現在那幾處
# 跑上游測試基準與 fork 測試，兩者都沒有新增失敗才 push
git push origin main
```

注意事項：
- 上游 `manifest.json` 的 `version` 每次發版都會變。fork 的版號策略在第 1 階段決定，同時處理改名。
- 上游 `lib/model-pricing.js` 常調整價格。fork 新增的模型列放在獨立區段，減少衝突。
- 上游 `safari-app/` 不維護但保留，合併時直接接受上游版本。
