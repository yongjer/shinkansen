# 現有架構摘要（Fork 第 0 階段）

> 本文件屬於 fork 自有文件，不屬於上游 Shinkansen。內容是動工前對上游程式碼的閱讀筆記，供後續各階段決定「掛鉤點」時引用。
>
> - 基準版本：上游 `jimmysu0309/shinkansen` v2.6.4，commit `4ebf220`（2026-11-01）
> - 閱讀日期：2026-11-09
> - 上游公開 SPEC 自 2026-08-06 起只保留使用者面向的功能規格，內部訊息協定、cache key 組裝、序列化協定等「實作藍圖」放在不公開的 `SPEC-PRIVATE.md`。以下內部細節都是直接讀程式碼得到的，並非上游官方文件。

## 1. 執行環境與檔案佈局

| 層 | 檔案 | 說明 |
|---|---|---|
| Service worker | `shinkansen/background.js`（ES module，約 140 KB） | 訊息路由、快取、計費、快捷鍵、徽章、跨分頁 sticky 翻譯、Instapaper |
| 引擎與共用程式庫 | `shinkansen/lib/*.js` | `gemini.js`、`openai-compat.js`、`google-translate.js`、`llm-common.js`、`translate-pipeline.js`、`billing.js`、`model-pricing.js`、`cache.js`、`usage-db.js`、`storage.js` 等 |
| Content scripts（isolated world） | manifest 依序載入：`content-ns.js` → `lib/distribution-cs.js` → `lib/i18n-content.js` → `lib/shortcut-utils.js` → `lib/format-currency.js` → `lib/domain-utils.js` → `lib/edit-link-repair.js` → `lib/readability.js` → `content-toast.js` → `content-detect.js` → `content-serialize.js` → `content-inject.js` → `content-spa.js` → `content-youtube.js` → `content-drive.js` → `content-x.js` → `content-touch.js` → `content.js` → `content-shortcuts.js` → `content-hover.js` → `content-floating-icon.js` | 全部掛在 `window.__SK`（`content-ns.js` 建立的命名空間，共用 `SK.STATE`），`all_frames: true` |
| Content scripts（MAIN world） | `content-youtube-main.js`（document_start，攔截 YouTube `/api/timedtext` XHR 與讀 `ytInitialPlayerResponse`）、`content-fw-detect-main.js`（前端框架偵測） | 透過 `CustomEvent` 與 isolated world 溝通 |
| 擴充頁面 | `popup/`、`options/`、`translate-doc/`（web_accessible） | popup 與 options 直接讀寫 `chrome.storage`，不經訊息層 |
| 建置 | 無 bundler、無 transpile | 第三方函式庫以原始檔放在 `lib/vendor/`。Firefox 版由 `tools/release/firefox-build.sh` 用 jq 改寫 manifest（`service_worker` 換成 `background.scripts`，並加上 `strict_min_version: 128.0`） |
| 測試 | `jest.config.cjs`（`**/test/jest-unit/**/*.test.cjs`）、`playwright.config.js`（`testDir: ./test`） | **`test/` 自 2026-08-06 起移到上游私有 repo `jimmysu0309/Shinkansen-test`，並列入 `.gitignore`**。公開歷史最後一版在 commit `8f4c2cb^`（416 個 Playwright spec + 43 個 jest 檔） |

## 2. 訊息流程

```
popup / options ──(chrome.storage 直接讀寫)──> 設定
popup ──tabs.sendMessage──> content.js     TRANSLATE_PRESET / TOGGLE_TRANSLATE / GET_STATE / TOGGLE_EDIT_MODE …
commands（Alt+S/A/D/I）──> background ──tabs.sendMessage──> content（TRANSLATE_PRESET）
content ──runtime.sendMessage({type, payload})──> background.messageHandlers[type]
background ──sendResponse({ok:true, ...result} | {ok:false, error, errorCode, errorParams})──> content
background ──tabs.sendMessage──> content    STREAMING_FIRST_CHUNK / STREAMING_SEGMENT / STREAMING_DONE / STREAMING_ERROR / STREAMING_ABORTED
MAIN world <──CustomEvent──> isolated world（shinkansen-yt-captions、shinkansen-yt-player-response …）
```

- **路由表**：`background.js` 的 `const messageHandlers = { TYPE: { async, handler } }`，由單一 `runtime.onMessage` listener 分派。不認得的 `type` 直接 `return`（不回應），所以**可以另外掛一個 listener 只處理 fork 自己的訊息類型，完全不必改到路由表**。
- **錯誤協定**：`lib/bg-error.js` 的 `codedError()` 帶 `skCode`，content 端再查 i18n 字典轉成使用者語言。背景檔不准 throw 寫死的中文（上游有 jest forcing function 檢查）。
- **串流**：網頁翻譯第 0 批走 `TRANSLATE_BATCH_STREAM`（立即 ack，結果用 `tabs.sendMessage` 推回），其餘批次走一般 request/response。用 `inFlightStreams`（streamId → AbortController）加上 abort tombstone 處理取消。
- **Keep-alive**：iOS 用 `shinkansen-keepalive` port；串流期間用 `chrome.alarms`（30 秒）維持 SW 存活。

目前的訊息類型（共 56 個）：`RELOAD_EXTENSION`、`OPEN_FEATURE_MENU`、`CONVERT_ZH_LOCAL`、`TRANSLATE_BATCH`、`TRANSLATE_BATCH_STREAM`、`TRANSLATE_SUBTITLE_BATCH_STREAM`、`STREAMING_ABORT`、`TRANSLATE_SUBTITLE_BATCH`、`TRANSLATE_ASR_SUBTITLE_BATCH`、`TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH`、`TRANSLATE_X_ASR_SUBTITLE_BATCH`、`DRIVE_TIMEDTEXT_URL`、`TRANSLATE_BATCH_GOOGLE`、`TRANSLATE_DOC_BATCH`、`TRANSLATE_DOC_BATCH_CUSTOM`、`TRANSLATE_DRIVE_BATCH_GOOGLE`、`TRANSLATE_X_BATCH_GOOGLE`、`TRANSLATE_BATCH_CUSTOM`、`TRANSLATE_SUBTITLE_BATCH_CUSTOM`、`TRANSLATE_ASR_SUBTITLE_BATCH_CUSTOM`、`TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH_CUSTOM`、`TRANSLATE_X_ASR_SUBTITLE_BATCH_CUSTOM`、`TRANSLATE_SUBTITLE_BATCH_GOOGLE`、`EXTRACT_GLOSSARY`、`EXTRACT_GLOSSARY_CUSTOM`、`SCAN_TERM_RENDERINGS`、`TEST_GEMINI_KEY`、`TEST_CUSTOM_PROVIDER`、`CLEAR_CACHE`、`CACHE_STATS`、`SET_BADGE_TRANSLATED`、`CLEAR_BADGE`、`FOUR_FINGER_TAP`、`FOUR_FINGER_LONGPRESS`、`STICKY_QUERY`、`STICKY_SET`、`STICKY_CLEAR`、`LOG`、`GET_LOGS`、`CLEAR_LOGS`、`GET_PERSISTED_LOGS`、`CLEAR_PERSISTED_LOGS`、`OPEN_GDOC_MOBILE`、`LOG_USAGE`、`QUERY_USAGE`、`QUERY_USAGE_STATS`、`QUERY_USAGE_CHART`、`QUERY_USAGE_PAGE`、`EXPORT_USAGE_CSV`、`CLEAR_USAGE`、`EXCHANGE_RATE_GET`、`EXCHANGE_RATE_REFRESH`、`SUMMARIZE_FOR_INSTAPAPER`、`UPDATE_NOTICE_DISMISSED`、`WELCOME_NOTICE_DISMISSED`、`WELCOME_NOTICE_TOAST_SHOWN`（另有 iOS 專用的 `PULL_HOST_SETTINGS` listener）。

## 3. 翻譯引擎抽象層

上游**沒有「引擎註冊表」**。抽象只做到「兩個 LLM adapter 共用引擎層與 pipeline」；機器翻譯（Google）是另一條獨立路徑。引擎的選擇是「引擎 × 用途」的二維訊息類型路由。

### 3.1 背景端

| 引擎 id | Adapter | 共用層 |
|---|---|---|
| `gemini` | `lib/gemini.js`：`translateBatch`、`translateBatchStream`、`extractGlossary`、`extractTermRenderings`、`summarizeArticle`；`pickThinkingConfig`、取樣參數依模型決定送或不送、`parseGeminiUsage`（output = candidates + thoughts） | `lib/llm-common.js`：`fetchWithRetry`（逾時、429 退避與 Retry-After、5xx）、`alignAndFallback`（段數對齊、序號標記二次對齊、逐段 fallback）、`runChunkedBatch`、`parseLlmJson` |
| `openai-compat` | `lib/openai-compat.js`（單一組 `settings.customProvider`）＋ `openai-compat-thinking.js` | 同上 |
| `google` | `lib/google-translate.js`：`translateGoogleBatch(texts, targetLanguage)`，非官方免金鑰端點，有 URL 長度切段 | 不走 LLM 共用層 |

- `lib/system-instruction.js`：`packChunks`（字元預算＋段數上限）、`buildEffectiveSystemInstruction`（把文章術語表、固定術語表、禁用詞注入 system prompt 末端）、echo 偵測、輸出語言驗證。
- `lib/translate-pipeline.js`：`createTranslatePipeline(deps)` 收斂三條 LLM handler 的流程：`prepareBatch`（固定術語表 → 禁用詞 → cache key suffix → `cache.getBatch`）→ `translate()` → 禁用詞漏網掃描（只記 log，不改譯文）→ echo 過濾後 `writeBatchCache` → `computeBilling` → 網頁路徑逐批寫 usage-db。依賴由 background 注入，pipeline 本身不知道是哪個引擎。
- background 的 handler：`handleTranslate`（Gemini）、`handleTranslateStream`、`handleTranslateCustom(payload, sender, cacheTag, cpOverrides, …)`（**已經有 `cpOverrides` 參數，可以傳入另一組 provider 設定**）、`handleTranslateGoogle`（自己查快取，沒有術語表、沒有禁用詞）。

### 3.2 Content 端

- **LLM 路徑**：`SK.translateUnits(units, { engine, modelOverride, glossary, … })`，用佔位符序列化協定（`content-serialize.js`）保留行內元素，依 engine 選 `TRANSLATE_BATCH` 或 `TRANSLATE_BATCH_CUSTOM`，第 0 批用串流。
- **MT 路徑**：`SK.translateUnitsGoogle` / `SK.translatePageGoogle`，改用 `SK.GT_INLINE_TAGS` 標記保護行內標籤，送 `TRANSLATE_BATCH_GOOGLE`。
- **分派點**：`content.js` 的 `handleTranslatePreset(slot)` 依 `preset.engine`（`google` / `openai-compat` / 預設 gemini）決定呼叫哪條路徑；SPA 續翻走 `SK.translateUnitsByProvider`，依 `STATE.translationContext.provider` 分派。
- 字幕路由集中在 `SK.getSubtitleBatchType(engine, asr)`（`content-ns.js`）；術語表抽取路由在同檔。
- 文件翻譯（`translate-doc/translate.js`）只支援 `gemini` 與 `openai-compat`，Google MT 在 UI 上 disabled。

**對 fork 的意義**：新增的 MT 引擎（微軟、DeepL、DeepLX、Chrome Translator、備援鏈）應掛在「MT 路徑」，並使用新的訊息類型；新增的多組 OpenAI 相容端點掛在「LLM 路徑」，透過既有的 `cpOverrides` 參數重用 `handleTranslateCustom`。現有三種引擎的訊息類型與行為不動。

## 4. 快取

- `lib/cache.js`，存在 `chrome.storage.local`。key = `tc_` + SHA-1(原文) + suffix；值為 `{ v: 譯文, t: 時間戳 }`。
- suffix 依情境分區：引擎、用途（網頁 / 字幕 `_yt` / ASR / Drive / 文件 `_doc` / 自訂 `_oc`）、文章術語表、固定術語表、禁用詞清單 hash、模型、目標語言、非預設 temperature、自訂 prompt、文件額外指令。組裝在 background 的 `buildCacheKeySuffix()`。
- 容量上限 9.5 MB（storage.local 預設 10 MB），LRU 淘汰一次騰出 1 MB；命中時的時間戳更新以 5 秒 debounce 批次寫回。
- 另有 `gloss_`（術語表）、`scanr_`（EPUB 一致性掃描）兩種前綴；`__cacheVersion` 只更新標記，版本升級不清快取。
- 寫入前做 echo 過濾：譯文等於原文而且原文不是目標語言字系的段落不寫入。
- **限制**：storage.local 幾乎被翻譯快取佔滿，fork 不應再把大型資料（音訊、OCR 語言包、學習資料）放進 storage.local，應該用 IndexedDB 或 Cache Storage。

## 5. 用量計費

- **公式**：`lib/billing.js` 的 `computeBilling(usage, pricing, cachedRate)` 是唯一入口，回傳原始費用與套用快取折扣後的實付費用（`billedInputTokens`、`billedCostUSD`）。
- **計價表**：`lib/model-pricing.js` 的 `MODEL_PRICING`（每個模型一組 `inputPerMTok` / `outputPerMTok` / `cachedDiscount`）、`LAST_CALIBRATED_DATE`、`getPricingForModel(model, settings)`（使用者可在 `settings.modelPricingOverrides` 逐欄覆蓋）。**每個模型只有一組輸入價與一組輸出價，沒有依模態（文字 / 圖片 / 音訊）分價，也沒有生效日期。**
- **紀錄**：`lib/usage-db.js`，IndexedDB `shinkansen-usage` / store `translations`（autoIncrement、`timestamp` index）。欄位：`url`、`title`、`model`、`engine`、`inputTokens`、`outputTokens`、`cachedTokens`、`billedInputTokens`、`billedCostUSD`、`segments`、`cacheHits`、`durationMs`、`chars`（Google）、`source`、`videoId`、`partialFailure` 等。
- **寫入路徑**：網頁翻譯的 LLM 批次由 background 逐批寫入（同頁三分鐘內合併）；字幕與文件由 content 端送 `LOG_USAGE`；YouTube / Drive / X 字幕依影片 upsert 合併；Google MT 整頁合併；「結果作廢但已付費」的用量另走 `logDiscardedUsage` 記帳；全部命中本地快取的紀錄不寫入。
- **呈現**：options「用量紀錄」分頁（Chart.js 折線圖、彙總卡、明細、日期 / 模型 / 網域篩選），`exportCSV()` 的欄位是寫死的 11 欄；popup 顯示從 `usageResetAt` 起算的累計費用。

## 6. 設定儲存

- `lib/storage.js` 的 `DEFAULT_SETTINGS` 存 `chrome.storage.sync`（總量 100 KB、單一 key 8 KB）。讀取一律走 `getSettingsCached()`（sync 或相關 local key 一變動就失效重讀），並在讀取時跑一串 migration（模型改名、舊 key 搬家）。
- **機密只放 `chrome.storage.local`**：`apiKey`（Gemini）、`customProviderApiKey`、`instapaperToken` / `instapaperTokenSecret`。不跨裝置同步，也不在匯出範圍。
- **大型設定放 local**：`fixedGlossary`、`forbiddenTerms`（`LOCAL_SETTINGS_KEYS`），匯出時仍包含在內。
- **匯出 / 匯入**：options 頁輸出 JSON（不含任何金鑰）；匯入走 `options/import-sanitize.js` 的 `sanitizeImport()`，逐欄驗證型別與範圍，不認得的 key 一律丟棄。上游有 forcing-function 測試要求 `DEFAULT_SETTINGS` 每個 key 都能通過 round-trip，新增設定沒補規則測試就會失敗。若匯入檔把 `customProvider.baseUrl` 換到不同 origin，會清除既有的自訂模型金鑰。
- options 多數欄位即時自動儲存。

## 7. 字幕 overlay

- **YouTube**（`content-youtube.js` 約 258 KB ＋ `content-youtube-main.js`）
  - 取得字幕：MAIN world 攔截播放器自己的 `/api/timedtext` XHR（含 POT），用 `CustomEvent` 傳回 isolated world，存成 `YT.rawSegments[{ text, normText, startMs }]`。字幕軌選擇器 `_chooseBestCaptionTrack` 依目標語言與原音 ASR 軌決定。
  - 翻譯排程：按影片時間切成 30 秒視窗（`windowSizeS`），剩餘時間少於 `lookaheadS`（10 秒）時預先翻下一個視窗。由 `timeupdate`、`seeked`、`ratechange` 驅動。
  - ASR（YouTube 自動字幕）：`asrMode: progressive` 先用本地啟發式合句立刻顯示，背景同時送 `TRANSLATE_ASR_SUBTITLE_BATCH` 由 LLM 依語意重新分句並翻譯（JSON 格式，帶時間戳），回來後替換。
  - 顯示：自家 overlay 疊在播放器內，旁路 YouTube 原生的 caption-segment，整句進整句出；雙語跟隨 `displayMode === 'dual'`；字型大小與顏色跟隨原生設定；另有 iOS 全螢幕用的 TextTrack。
  - **「沒有字幕」的權威判斷**：查詢 MAIN world 的 `ytInitialPlayerResponse.captions…captionTracks`，若確認是空的，就呼叫 `_maybeShowNoSubtitleToast()`（`SK._maybeShowNoSubtitleToast` 已暴露）。**這是第 5 階段 ASR 備援最自然的掛鉤點。**
  - 用量：每支影片合併成一筆（videoId + model，1 小時視窗）。
- **Google Drive**：iframe 內偵測 timedtext URL → top frame 的浮層 overlay。
- **X**：自動字幕 → AI 分句 → 原生 `TextTrack` 顯示；只在有聲播放時翻譯。

## 8. 文件翻譯管線

- 入口：popup →「翻譯文件」→ `translate-doc/index.html`（單頁應用，web_accessible）。依副檔名分流到各格式引擎：`pdf-engine.js` + `layout-analyzer.js` + `pdf-renderer.js`（PDF.js 解析、版面分析、pdf-lib 輸出譯文 PDF）、`epub-engine.js` / `epub-writer.js` / `epub-scan.js`、`docx-engine.js`、`doc-file-engine.js`（TXT / Markdown / HTML）、`subtitle-engine.js`（SRT / VTT / ASS）。
- 翻譯：`translate.js` 依 preset 選 `TRANSLATE_DOC_BATCH`（Gemini）或 `TRANSLATE_DOC_BATCH_CUSTOM`，每批預設 50 段，逾時 120 秒；可對切的錯誤遞迴切半重送；`block-output.js` 決定輸出優先順序（手動編輯 → 佔位符反序列化 → 純文字）。
- 書籍式文件（EPUB / DOCX / TXT / MD / HTML / 字幕）共用：全書術語表（`EXTRACT_GLOSSARY`）、譯後一致性掃描（`SCAN_TERM_RENDERINGS`）、預覽編輯、工作階段存檔（IndexedDB，`epub-session-db.js`）、費用預估。
- 快取沿用 `tc_`，獨立分區；簡中 / 日 / 韓 PDF 字型首次使用時從上游 GitHub Pages 下載（`lib/font-loader.js`，有 SHA-256 驗證）。

## 9. 其他與 fork 相關的模組

- **懸停翻譯** `content-hover.js`：按住修飾鍵、停留 150 ms，重用 rescan 路徑只翻游標下那一段；還原簿記共用 `STATE.originalHTML`（`Map<Element, innerHTML>`）。目前**只能整頁還原**。
- **還原**：`restorePage()` 迭代 `STATE.originalHTML` 寫回；dual 模式移除 `<shinkansen-translation>` wrapper。`Map` 以元素為 key，所以技術上可以只還原單一元素（第 2 階段「段落級還原」的基礎）。
- **快捷鍵**：manifest `commands` 已經用掉 Chrome 建議快捷鍵的 4 個名額（3 組 preset ＋ Instapaper），新的快捷鍵必須走 `content-shortcuts.js` 的頁內比對（同 `customShortcuts`）。
- **懸浮按鈕** `content-floating-icon.js`、**Toast** `content-toast.js`（Shadow DOM）、**Logger** `lib/logger.js`（記憶體 1000 筆、持久化 100 筆）、**i18n** `lib/i18n.js`（8 語自製字典，zh-TW 為準；`lib/i18n-content.js` 由 `tools/build/generate-i18n-content.mjs` 產生）。
- **更新檢查** `lib/update-check.js` 打上游的 GitHub Releases API；**字型下載** `lib/font-loader.js` 指向上游 GitHub Pages。fork 改名時必須處理，否則會提示使用者「有新版」並導向上游。
- **多份並存讓位**：同一頁若載入多份 Shinkansen，只有版本最高的一份會翻譯，其餘讓位。fork 沿用相同的內部 DOM 標記，所以與原版同時安裝會互相影響（見 GAP-ANALYSIS 的風險章節）。

## 10. 建議的掛鉤原則（摘要，細節在各階段 PR 的 FORK-NOTES）

1. fork 程式碼放在 `shinkansen/fork/`（擴充功能根目錄必須維持 `shinkansen/`，否則每次合併上游都會整個目錄衝突）。
2. 背景端：`background.js` 只加一行 `import './fork/bg/index.js'`，fork 模組自己註冊 `runtime.onMessage` listener，只處理 `FORK_` 前綴的訊息類型；需要重用的內部函式（例如 `handleTranslateCustom`、`buildCacheKeySuffix`）在檔尾用一行 `export { … }` 暴露。
3. Content 端：fork 的 content scripts 加在 manifest 清單最後；`content.js` 只在 `handleTranslatePreset` 與 `translateUnitsByProvider` 各加一個「fork 引擎先問 fork 要不要處理」的早退判斷。
4. 設定：fork 的設定集中在 `DEFAULT_SETTINGS.fork`（單一子物件），機密放 local 並用 `fork` 前綴；`sanitizeImport` 只加一條 `fork` 規則，交給 fork 自己的 sanitizer 處理。
5. 內部識別字（CSS class、`<shinkansen-translation>`、storage key、DB 名稱）一律不改名，只改使用者看得到的名稱。
