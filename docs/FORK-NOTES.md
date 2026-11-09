# Fork 作業筆記

> Fork 自有文件。這份文件記錄 fork 與上游 Shinkansen 的差異：授權隔離、作業規範、上游核心檔的每一處掛鉤，以及如何同步上游。
> 每個階段的 PR 都必須更新本檔的 §4 掛鉤清單。

- 上游：[jimmysu0309/shinkansen](https://github.com/jimmysu0309/shinkansen)（Elastic License 2.0）
- Fork 起點：上游 v2.6.4，commit `4ebf220`
- 擴充功能新名稱：**驛傳 Ekiden**（2026-11-09 決定，見 GAP-ANALYSIS §6.1）

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
| 擴充頁面 | `shinkansen/fork/pages/`：驛傳設定頁是 `settings.html`；之後的大型頁面（學習中心、翻譯中心）各自一個子目錄 |
| Offscreen 文件 | `shinkansen/fork/offscreen/`（第 5、6 階段） |
| 訊息類型 | 一律加 `FORK_` 前綴，由 fork 自己的 `runtime.onMessage` listener 處理；上游的 router 遇到未知類型時不回應，不會衝突 |
| 設定 | 同步設定放 `storage.sync` 的 `fork` key（結構、預設值、消毒規則都在 `fork/settings/schema.js`，**不改** `DEFAULT_SETTINGS`）。機密放 `storage.local` 的 `forkSecrets`（DeepL / Azure / DeepLX 金鑰、額外服務的金鑰、WebDAV 密碼）；額外服務的 system prompt 放 `forkProviderPrompts`（可能很長，不佔 sync 配額）；備份同步狀態放 `forkBackupState` |
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
- 前一階段的 PR 還沒合併時，下一階段的分支疊在它上面，PR 的 base 設成前一階段的分支。前一階段合併後，把 base 改回 `main`；如果合併時刪除了分支，GitHub 會自動改。
- PR 由你合併，不自動合併。
- 每個階段的 PR 都要：
  - 更新 `SPEC.md` 的 fork 章節（從第 1 階段起新增，上游章節不動）。
  - 更新 `CHANGELOG.md`。
  - 更新本檔 §4。
  - 附上新功能的測試，以及「載入未封裝擴充功能的步驟、已知限制、manifest 權限變更」說明。
- 第 0 階段只新增文件，不改 SPEC.md 與 CHANGELOG.md。

### 3.4 測試

#### 上游測試（`test/`）

- 上游測試自 2026-08-06 起移到私有 repo，公開 repo 沒有測試。依 GAP-ANALYSIS §6.1 決定 2，fork 把公開 repo 最後一版測試（commit `8f4c2cb^`）放進版控：`.gitignore` 拿掉 `test/` 那一行（改成說明註解），`test/` 以獨立 commit 加入。
- 這份測試比 v2.6.4 舊約三個月，部分測試對應的實作後來改過，所以在**未修改的 v2.6.4** 上本來就有失敗。這些失敗是基準，fork 的驗收標準是「**沒有新增失敗**」，不是全綠。
- 基準（2026-11-09，Linux、Node 26、Playwright 1.59.1，在未修改的 v2.6.4 worktree 上跑）：

  | 套件 | 指令 | 通過 | 失敗 | 略過 |
  |---|---|---|---|---|
  | jest | `npx jest --config jest.config.cjs` | 244 | 33（13 個 suite） | 0 |
  | Playwright | `npx playwright test` | 1466 | 90 | 1 |

- 上游測試改了 4 處（見 §4），除此之外 `test/` 與 `8f4c2cb^` 逐位元組相同：
  - 3 處是因為改名後 isolated world 的名稱從 Shinkansen 變成 Ekiden。
  - 1 處修掉測試本身的競速。
- 比對方式：用 JSON reporter 輸出，列出「非 expected」的測試（檔案 + 標題），和基準清單做差集。新增的失敗必須修掉或說明。
- **這份測試有不少時序敏感的 flaky 測試**，基準本身每次跑的失敗清單也不完全相同，所以差集裡的項目要單獨重跑多次，和基準比較失敗率：
  - 最常見的是 `page.goto: Navigation … is interrupted by another navigation to …/options/options.html`。原因是上游在首次安裝時自動開設定頁，和測試第一次換頁競速。每個測試都是新安裝，所以任何一個測試都可能遇到。
  - 判斷方式：在基準 worktree 與 fork 分支上用 `--repeat-each` 重跑同一組 spec，比較失敗次數。
- **舊測試與四段版號**：上游 2026-09-11 起，Debug Bridge 的敏感動作只在四段版號（開發版）開放。這份測試早於該改動，所以依賴 Debug Bridge 的 spec 在三段版號下本來就會失敗；基準與 fork 都是三段版號，結果一致。

#### Fork 測試（`fork-tests/`）

- 放在獨立目錄，不和上游的 `test/` 混在一起：

  ```
  fork-tests/
    jest.config.cjs        單元測試設定（rootDir = repo 根目錄、transform 關閉）
    helpers/               mock fetch、假的 chrome.storage
    unit/*.test.mjs        單元測試
    e2e/                   Playwright：載入未封裝的驛傳，跑整條掛鉤路徑
  ```

- 沿用上游的框架（jest 29 + Playwright），差別只有一點：fork 的模組是 ES module，所以單元測試寫成 `*.test.mjs`，用 `node --experimental-vm-modules` 直接 import 原始檔，不需要 bundler 或 Babel 轉譯。
- 指令：
  - `npm run test:fork`：單元測試
  - `npm run test:fork:e2e`：端對端測試（需要 Playwright 的 Chromium）
- 新引擎一律附 mock 回應的單元測試，不打真實 API。
- `guards.test.mjs` 把作業規範寫成測試，包括：
  - fork 程式碼不把金鑰放進網址。
  - fork 程式碼只連到列出的主機。
  - manifest 沒有移除上游權限。
  - 名稱與描述不出現 Shinkansen。
  - LICENSE 與上游逐位元組相同。
  - 8 種語言的 fork 字串 key 一致。
  - 品牌改名不動到授權區塊。

## 4. 上游核心檔的掛鉤清單

每一處對上游檔案的修改都記在這裡，方便合併上游時檢查。

| 階段 | 檔案 | 位置 | 修改內容 | 原因 |
|---|---|---|---|---|
| 0 | — | — | 沒有修改任何上游檔案（只新增 `docs/ARCHITECTURE-SUMMARY.md`、`docs/GAP-ANALYSIS.md`、`docs/FORK-NOTES.md`） | — |
| 1 | `shinkansen/background.js` | import 區末尾 | `import { initFork, forkRoutes } from './fork/bg/index.js'` | 驛傳背景端唯一入口 |
| 1 | `shinkansen/background.js` | `messageHandlers.TRANSLATE_BATCH_GOOGLE` | payload 帶 `mtEngine` 時改呼叫 `forkRoutes.mt`，否則照舊呼叫 `handleTranslateGoogle` | 三組預設可改用其他機器翻譯引擎；沿用上游的批次、序列化、快取路徑 |
| 1 | `shinkansen/background.js` | `messageHandlers.TRANSLATE_BATCH_CUSTOM` | `modelOverride` 是 `fork-cp:<id>` 時改呼叫 `forkRoutes.provider`，它換掉 customProvider 欄位後仍呼叫上游 `handleTranslateCustom` | 多組 OpenAI 相容服務，不另寫一套翻譯管線 |
| 1 | `shinkansen/background.js` | `runtime.onMessage` listener 之前 | `initFork({ handleTranslateCustom, errorFields })` | 把上游內部函式交給 fork 重用 |
| 1 | `shinkansen/content.js` | `SK.translateUnitsGoogle` | 多收一個 `mtEngine` 選項，放進 `TRANSLATE_BATCH_GOOGLE` payload；送出前先給 `SK.forkInterceptMt` 接手（Chrome 內建翻譯在頁面內執行） | 同上 |
| 1 | `shinkansen/content.js` | `translatePageGoogle` | ① toast 的 4 個呼叫多帶 `engine` 參數（key 不變，由 `ekiden-content.js` 換成「微軟翻譯 完成」等字串；`engine` 是空字串時與上游相同）② `translationContext` 記住 `mtEngine` | toast 顯示實際引擎；SPA 換頁與重新掃描時沿用同一個引擎 |
| 1 | `shinkansen/content.js` | 重新掃描（`ctx.provider === 'google'`）與 SPA 重播 | 把 `ctx.mtEngine` 傳下去 | 同上 |
| 1 | `shinkansen/content.js` | `handleTranslatePreset` | 先呼叫 `SK.forkResolvePreset(slot, engine)`，結果是 `{}` 時與上游相同；有值時帶 `mtEngine` 或 `modelOverride` | 三組預設改用驛傳引擎的入口 |
| 1 | `shinkansen/content-hover.js` | `resolveRunner` | 同上，套用主要預設的對應 | 懸停翻譯也套用預設的引擎 |
| 1 | `shinkansen/lib/usage-db.js` | 新增 `upsertCharUsage`；`exportCSV` | 新函式，合併規則比照 `upsertGoogleUsage`；CSV 末尾加「字元數」欄（既有 11 欄順序不變） | 以字元計費的引擎（微軟、DeepL 等）寫進同一個用量紀錄 |
| 1 | `shinkansen/options/options.js` | 用量表格 `renderTable` | `isGoogle` 判斷加上 `r.billingUnit === 'chars'` | 以字元計的紀錄顯示字元數，不顯示 token |
| 1 | `shinkansen/lib/model-pricing.js` | `gemini-3.8-flash` 列；`getPricingForModel`；檔尾 | ① 加 `schedule`（2027-01-01 起新價）② 多收 `at` 參數 ③ 檔尾獨立區段：`resolveScheduledPricing`、語音模型的多模態計價表 `MODALITY_MODEL_PRICING` 與計算函式 | 促銷價到期自動換價；TTS、即時轉錄、即時口譯的價格集中在同一份計價表 |
| 1 | `shinkansen/options/import-sanitize.js` | import 區；`sanitizeImport` 結尾 | 匯入檔有 `fork` 欄位時交給 `sanitizeForkSettings` | 上游的「匯入設定」也能匯入驛傳設定，經同一套消毒規則 |
| 1 | `shinkansen/lib/update-check.js` | `GITHUB_RELEASES_URL` 與 3 個下載網址 | `jimmysu0309/shinkansen` → `yongjer/shinkansen` | 新版提示指向驛傳自己的 Releases，不提示安裝上游版本 |
| 1 | `shinkansen/lib/font-loader.js` | `FONT_CONFIG.baseUrl` | 改成 `raw.githubusercontent.com/yongjer/shinkansen/<4ebf220 完整 hash>/docs/fonts/` | PDF 字型由 fork 自己的 repo 提供（說明見 §5.2） |
| 1 | `shinkansen/manifest.json` | — | 版號 `2.6.401`（§5.1）；`homepage_url`；Firefox `gecko.id` 改成 `ekiden@yongjer.github.io`；`optional_permissions: ["identity"]`；`host_permissions` 加 6 個主機；主 content script 清單末尾加 `fork/i18n/fork-strings.js`、`fork/content/ekiden-content.js` | 改名、Google Drive 備份、新引擎的端點 |
| 1 | `shinkansen/_locales/*/messages.json`（8 種） | `extName`、`extDescription`、`actionTitle` | 改成驛傳 Ekiden 的名稱與描述 | 改名 |
| 1 | `shinkansen/icons/icon-{16,32,48,128}.png` | — | 換成驛傳的圖示（原始檔 `tools/fork/ekiden-icon.svg`） | 改名 |
| 1 | `shinkansen/options/options.html`、`popup/popup.html`、`translate-doc/index.html`、`translate-doc/settings.html` | `<title>`、標題文字；`lib/i18n.js` 後面 | 改成 Ekiden；加一行 `<script src="../fork/i18n/fork-i18n.js">` | 改名（上游 i18n 字串中的 Shinkansen 在執行期換成 Ekiden，授權區塊字串不動）；設定頁加驛傳設定入口與衍生作品聲明 |
| 1 | `.gitignore` | 「回歸測試套件」區塊 | 拿掉 `test/` 這一行，改成說明註解 | 上游測試放進 fork 版控（§3.4） |
| 1 | `test/regression/helpers/run-inject.js` | isolated world 搜尋 | 名稱比對也接受 `Ekiden` | isolated world 的名稱等於擴充功能名稱，改名後找不到 |
| 1 | `test/regression/detect-embedded-player-frame.spec.js` | 同上 | `/Shinkansen/` → `/Shinkansen\|Ekiden/` | 同上 |
| 1 | `test/jest-unit/i18n-key-references.test.cjs` | 掃描目錄 | 跳過 `shinkansen/fork/` | fork 字串不在 `lib/i18n.js`；等價檢查改在 `fork-tests/unit/guards.test.mjs` |
| 1 | `test/regression/inject-wrong-language-guard.spec.js` | 第一個測試 | 「設定 `STATE.targetLanguage = 'de'`」與「注入」從兩次 evaluate 合併成同一段同步程式碼 | 測試本身的競速，詳見下方說明 |
| 1 | `package.json` | `scripts` | 加 `test:fork`、`test:fork:e2e` | fork 測試指令 |

上游的 `DEFAULT_SETTINGS`、`lib/i18n.js`、`lib/google-translate.js`、`lib/storage.js` 都沒有修改。預計的掛鉤點見 ARCHITECTURE-SUMMARY §10。

**`inject-wrong-language-guard` 的競速**（第 1 階段調查）

- **測試的做法**：先用一次 evaluate 把 `STATE.targetLanguage` 改成 `de`，再用另一次 evaluate 注入中文，預期被擋下。
- **競速**：頁面載入時，上游的簡繁自動轉換（`autoConvertZhWithRetry` → `translatePage({ convertOnly: true })` → `applyTranslateDisplaySettings`）是非同步的，會依儲存的設定把 `STATE.targetLanguage` 寫回 `zh-TW`。它若剛好在兩次 evaluate 之間執行，測試就會失敗。
- **重跑結果**（每種 40 次）：

  | 版本 | 失敗次數 |
  |---|---|
  | fork 分支 | 5 |
  | 拿掉 fork 的 content script | 8 |
  | 再換回上游的 `background.js` | 0 |
  | 全部換回上游 | 1 |

- **結論**：
  - 驛傳背景端多出的模組讓 service worker 冷啟動稍慢，競速比較容易輸。
  - 上游本身也偶爾會輸。
  - 這不是使用者看得到的行為變化。
- **修法**：把「設定 `de`」和「注入」放進同一段同步程式碼，中間不可能插入其他非同步工作。
  - 修改後 80 次全部通過。
  - 把守門程式拿掉時，測試仍然 5 次全部失敗，所以測試照樣能抓到它要防的 bug。
- **之後各階段**：背景端越大，其他依賴頁面載入時序的上游測試也可能出現類似情況，處理原則相同：先在基準上重跑比較失敗率，再判斷是不是 fork 造成的行為變化。

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
- 上游 `lib/model-pricing.js` 常調整價格。fork 新增的模型列放在獨立區段，減少衝突。
- 上游 `safari-app/` 不維護但保留，合併時直接接受上游版本。
- `SPEC.md` 只在開頭加一行指向 §18，fork 內容都在 §18；`CHANGELOG.md` 的 fork 紀錄在最上方獨立一節。合併時上游的章節直接接受上游版本。
- 上游 i18n 字串新增的 Shinkansen 會在執行期自動換成 Ekiden（授權區塊除外），不需要手動改。

### 5.1 版號

- 格式：三段式 `<上游 major>.<上游 minor>.<上游 patch × 100 + fork 建置號>`，例如 `2.6.401` = 以上游 2.6.4 為基礎的第 1 版，`2.6.402` 是第 2 版，合併上游 2.6.5 後變成 `2.6.501`。建置號最多 99。
- **不能用四段版號**（例如 `2.6.4.1`）：上游把四段版號視為「開發中的未封裝版本」（`SK.isDevTailBuild()`），會對**所有網頁**開放 Debug Bridge 的敏感動作，例如讀取整份 `storage.sync`、讀取紀錄、用使用者的金鑰翻譯、檢視快取。商店版靠三段版號關閉這些動作（上游 2026-09-11 code review S-1）。`fork-tests/unit/guards.test.mjs` 會檢查版號是三段。
- 上游的新版檢查與升級歡迎訊息只比較前兩段（major / minor），所以 fork 建置號變動不會觸發提示；合併上游的 minor 版時才會。
- 第 1 階段一開始用過四段版號 `2.6.4.1`，跑上游測試時發現上述問題，提交前已改成 `2.6.401`。

### 5.2 PDF 字型來源

上游 PDF 譯文需要的 CJK 字型（Noto Sans SC / JP / KR，共 6 個檔案）原本從上游的 GitHub Pages 下載。GAP-ANALYSIS §6.1 決定 5 是改由 fork 自己提供，實作時有一處和原決定不同：

- **實際做法**：從 `raw.githubusercontent.com/yongjer/shinkansen/4ebf2200e69b1d2b961c9a04900ee77192e42d6b/docs/fonts/` 下載。這是 fork repo 裡上游起點 commit 的檔案。
- **為什麼不用 GitHub Pages**：fork 開 Pages 時，會把上游官網 `docs/index.html` 等頁面一併以 fork 的名義發布。只為了字型開 Pages 不划算，也容易讓人誤以為是官方網站。
- **安全性**：網址固定在某個 commit，內容不會變；下載後仍比對 `font-loader.js` 內建的 SHA-256 與檔案大小，不符就不使用。該網址回應 `Access-Control-Allow-Origin: *`，2026-11-09 確認可下載。
- **改用 Pages**：如果之後還是想改用 Pages，只要改 `FONT_CONFIG.baseUrl` 一行。

### 5.3 驛傳會連到哪些服務

上游原本的連線（Gemini、Google 翻譯非官方端點、使用者設定的自訂模型、Instapaper 等）不變。驛傳新增的連線**全部由使用者明確選擇才會發生**：

| 服務 | 主機 | 什麼時候連 | 送出的內容 |
|---|---|---|---|
| 微軟翻譯（Edge 免費端點） | `edge.microsoft.com`（取 token）、`api-edge.cognitive.microsofttranslator.com` | 選用微軟翻譯，或免費引擎備援鏈輪到它 | 要翻譯的文字 |
| Azure Translator | 預設 `api.cognitive.microsofttranslator.com`，或使用者填的端點 | 選用 Azure 且填了金鑰 | 文字；金鑰放在 header |
| DeepL | `api.deepl.com` 或 `api-free.deepl.com`（依金鑰類型） | 選用 DeepL 且填了金鑰 | 文字；金鑰放在 `Authorization` header |
| DeepLX | **只有**使用者填的網址，沒有預設值 | 選用 DeepLX，或備援鏈輪到它 | 文字；選填的 token 放在 header |
| Chrome 內建翻譯 | 不連網路（模型由 Chrome 下載） | 選用 Chrome 內建翻譯 | — |
| 額外的 OpenAI 相容服務 | 使用者填的網址 | 選用該服務 | 與上游自訂模型相同 |
| WebDAV | 使用者填的網址 | 按「測試 / 上傳 / 還原」 | 備份檔；帳密只用於 Basic 認證 |
| Google Drive | `accounts.google.com`（授權）、`www.googleapis.com`（應用程式資料夾） | 按「連結 Google Drive」並同意後才會用到；`identity` 權限也是那時才要求 | 備份檔 |
| PDF 字型 | `raw.githubusercontent.com` | 翻譯 PDF 並需要 CJK 字型 | 不送內容 |
| 新版檢查 | `api.github.com/repos/yongjer/shinkansen` | 與上游相同的檢查頻率 | 不送內容 |

- 免費引擎備援鏈的前一家失敗時，同一段文字會再送到下一家。設定頁有說明，使用者可以關掉其中任何一家。
- 備份檔預設不含任何金鑰。勾選「包含 API Key」後，金鑰會以使用者自訂的密語加密（AES-GCM，密鑰由 PBKDF2-SHA256 310,000 次推導）。WebDAV 密碼永遠不進備份。
