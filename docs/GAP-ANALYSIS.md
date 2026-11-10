# 差異分析（Gap Analysis）— 第 0 階段

> Fork 自有文件。比對對象：上游 Shinkansen v2.6.4（commit `4ebf220`）與 FluentRead 使用指南（2026-11-09 擷取）。
> 本階段只有分析，沒有修改任何程式碼。架構細節見 [ARCHITECTURE-SUMMARY.md](ARCHITECTURE-SUMMARY.md)，fork 的作業規範見 [FORK-NOTES.md](FORK-NOTES.md)。

## 0. 摘要

- FluentRead 的功能面遠比 Shinkansen 廣。逐項對照共 **115 項**：Shinkansen **已有 15 項**、**部分有 22 項**、**沒有 78 項**（另列 1 項 Shinkansen 獨有的功能 E25 作為參照）。
- 你列出的 10 個已知缺口全部屬實。另外補上 **20 多項**你沒列到的（區段翻譯、輸入框翻譯、翻譯中心、雙語句子高亮、分享卡片、寫作助理、個人校訂、網站偏好、會議字幕等），見 §3。
- 第 1–6 階段只涵蓋其中一部分。為了符合「涵蓋 FluentRead 有、Shinkansen 沒有的所有功能」，我建議**再加第 7、8 階段**，並把一組**我建議不做**的項目列為第 9 階段，請你逐項決定（§4）。
- 有 **4 件事會擋住後續階段**，需要你決定（§6）：
  1. 擴充功能的新名稱（目前是空白）。
  2. **上游的測試在私有 repo，公開 clone 裡沒有任何測試**，「既有測試全部通過」目前無法驗證。另外，這台機器沒有安裝 Node.js。
  3. **Gemini Live API 的 WebSocket 必須用 URL 參數帶憑證**，瀏覽器的 WebSocket 不能設 header，所以第 5、6 階段無法做到「key 只放在 `x-goog-api-key` header」。可行的替代做法是用 header 帶 key 換一個短效的 ephemeral token，WebSocket URL 裡只放這個 token。
  4. **官方文件找不到 TTS 的 `/IPA/` 讀音語法**，第 2 階段的這個需求要先實測。

## 1. 資料來源與方法

| 對象 | 來源 | 說明 |
|---|---|---|
| FluentRead | `README.md`（透過 GitHub API 只取 README）、使用指南 35 頁：`/en/guide/` 底下的 features、getting-started、webpage-translation、deepseek-harness（劃詞翻譯）、hover-translation、input-translation、translation-center、information-highlight、image-translation、area-translation、document-translation、video-subtitles、vocabulary-book、sentence-analysis、share-cards、writing-assistant、glossary、custom-hotkey、webdav、translation-stats、model-usage、chrome-translator、userscript、mobile-safari、thunderbird、zotero、faq、privacy、offline-install，以及 `/en/config/` 底下的 index、translation-engines、chatgpt-plan、appearance、site-adaptation、backup-sync | **沒有讀任何原始碼**（授權隔離紀錄見 FORK-NOTES §2） |
| Shinkansen | README.md、SPEC.md、CHANGELOG.md（v2.6.x、v2.5.x）、docs/、`shinkansen/` 主要模組 | 見 ARCHITECTURE-SUMMARY.md |
| Gemini | aistudio.google.com/docs（ai.google.dev 已轉址至此）：3.8 Flash / Flash-Lite TTS 模型頁、speech-generation、3.5 Transcribe、Live transcription、3.5 Live Translate、Live translate、ephemeral tokens、session management、image understanding、pricing，以及完整文件 `llms-full.txt` | `aistudio.google.com/learn/gemini-3-8-flash-tts-developer-guide` 是 JavaScript 渲染的頁面，抓不到內容（見 §5.3 R-12） |

狀態定義：
- **已有**：Shinkansen 已有對等功能。依你的規則保留 Shinkansen 版本，不做第二套。
- **部分有**：有相近功能但缺少部分行為。只補不足之處，掛在 Shinkansen 既有的實作上。
- **沒有**：需要新增。

## 2. FluentRead 功能逐項對照

階段代號：P1–P6 = 你定義的第 1–6 階段；P7、P8 = 我建議新增的階段；P9 = 建議不做或延後（需要你決定）。

### 2.1 網頁翻譯

| # | FluentRead 功能 | Shinkansen | 預計實作方式 | 階段 |
|---|---|---|---|---|
| W1 | 整頁翻譯：雙語 / 僅譯文 | **已有**（單語覆蓋 / 雙語對照） | 保留 Shinkansen 版本 | — |
| W2 | 已翻譯時切換顯示模式，現有譯文直接更新，不重打 API | **部分有**（上游會跳 toast，要求重新翻譯） | 改上游預設行為違反你的規則，所以做成**選用**開關：從 `STATE.translatedHTML` 與 `originalHTML` 重組 | P7 |
| W3 | 依閱讀位置漸進翻譯（捲到哪翻到哪；可設定「不捲動就先翻 N 字」） | **部分有**（整頁一次翻完、漸進注入；有「只翻文章開頭」） | 新增選用的「依捲動位置翻譯」模式：IntersectionObserver ＋ 既有 `translateUnits`；預設維持整頁。上游 SPEC §2.3 列「延遲載入」為不做，fork 另行註記 | P7 |
| W4 | 區段翻譯：預覽高亮、點選鎖定、↑↓ 擴大縮小、拖曳多段、Enter 確認；已翻區段再選可還原 | **沒有** | 重用懸停翻譯的「`collectParagraphs(root)` 只翻子樹」路徑；新增選取 UI（Shadow DOM） | P7 |
| W5 | 記住區段規則（目錄 / 全站、提醒或自動翻譯，上限 100 條） | **沒有** | 規則存 `storage.local`，載入時比對 | P7 |
| W6 | 懸停翻譯：按 Ctrl 翻譯，再按一次還原；延遲可調；輸入框內不觸發 | **部分有**（修飾鍵＋停留 150 ms；只能整頁還原） | 段落級還原見 W7；延遲改成可調 | P2 |
| W7 | 段落級還原（游標所在段落按快捷鍵只還原該段） | **沒有** | `STATE.originalHTML` 以元素為 key，單段寫回原文或移除 dual wrapper；同步清理 `translatedHTML` 與 Content Guard 簿記 | P2 |
| W8 | 段落複製 Alt+C（依目前顯示 / 原文 / 譯文 / 兩者） | **沒有** | 與 W7 共用「游標所在段落」偵測 | P2 |
| W9 | 輸入框翻譯（連按三次空白 / = / -；取代原文或保留雙語；不會替你送出） | **沒有**（上游 SPEC §2.3 明確不做） | content script 監聽 `input` / `contenteditable`；排除密碼欄與程式碼編輯器 | P7 |
| W10 | 翻譯中心：多服務並排比較同一段文字、拖曳排序、複製 | **沒有** | 新的擴充頁面，等 P1 的引擎註冊表完成後實作 | P7 |
| W11 | 側邊欄翻譯（Chrome / Edge / Firefox） | **沒有** | Chrome 用 `sidePanel`、Firefox 用 `sidebar_action`，內容與 W10 共用 | P7 |
| W12 | 智慧重點標示：關鍵字模式（本機運算） | **沒有** | 本機頻率與詞性啟發式，用 CSS Custom Highlight API 呈現，不改 DOM | P7 |
| W13 | 智慧重點標示：Surprisal 模式（本機 Qwen2.5 0.5B，約 490 MB） | **沒有** | 需要 ONNX Runtime Web（MIT）與約 490 MB 模型（Apache-2.0）。份量很重，建議延後 | P9 |
| W14 | 雙語句子對照高亮（游標指到句子，高亮對應的原文或譯文） | **沒有** | CSS Custom Highlight API；以句序與相對長度對齊 | P7 |
| W15 | 翻譯樣式：文字 / 顏色 / 線條 / 螢光 / 卡片 / 趣味六類；模糊到懸停才顯示、塗黑；自訂顏色、字級 50–250%、字型、透明度、自訂 CSS 宣告；具名樣式 | **部分有**（4 種雙語標記＋強調色） | 在既有 `translationMarkStyle` 上擴充新的樣式值；自訂 CSS 只接受白名單屬性（不收 selector、url、定位屬性） | P7 |
| W16 | 選單佈局：拖曳排序、隱藏不用的項目 | **沒有** | popup 項目改成資料驅動，順序存 sync | P7 |
| W17 | 頁面懸浮球 | **已有**（懸浮按鈕） | 保留 Shinkansen 版本 | — |
| W18 | 右鍵選單：翻譯本頁 / 翻譯選取文字 / 翻譯圖片 | **沒有** | 新增 `contextMenus` 權限；選取文字在 P2，圖片在 P4，本頁在 P2 一併加入 | P2 / P4 |
| W19 | 自動翻譯網站 | **已有**（網域白名單，支援萬用字元） | 保留 | — |
| W20 | 網站偏好：在某網站停用擴充、隱藏懸浮按鈕、僅譯文顯示 | **部分有**（只有自動翻譯白名單） | 擴充成 per-site 偏好表 | P7 |
| W21 | 跳過的語言（可多選，簡繁分開） | **部分有**（只會跳過目標語言） | 擴充既有的語言偵測 | P7 |
| W22 | 手動指定來源語言 | **部分有**（只有自動偵測） | 對 MT 引擎有意義，P1 引擎設定一併提供 | P1 |
| W23 | 頁面辨識：全節點辨識、側欄翻譯、段落最少字數、長段落逐句換行、雙語順序（譯文在前） | **部分有**（偵測規則固定，內容取捨交給 prompt） | 只做「段落最少字數」與「雙語順序」兩項；全節點辨識與上游「交給 prompt 判斷」的原則衝突，不做 | P7 |
| W24 | AI 上下文（送頁面標題、所在章節、鄰近段落、先前譯名） | **部分有**（術語表一致化、同批段落本身就是上下文） | 選用開關，把標題與章節標題注入 prompt；預設關閉 | P7 |
| W25 | 個人校訂：修改譯文後自動重用（同頁 / 專案、上限 1000 筆） | **部分有**（可編輯譯文，但不保存、不重用） | 把手動修改寫進獨立的 override 快取（與 `tc_` 分區），翻譯時優先套用 | P8 |
| W26 | 論文網站捷徑（arXiv HTML、PMC、HF Papers、ACL、CVF、NeurIPS 的 PDF） | **沒有** | 站點 adapter，在頁面加入「雙語翻譯 / 用文件翻譯開啟 PDF」入口 | P8 |
| W27 | 失敗段落定位與重試 | **部分有**（文件翻譯有；網頁翻譯只有錯誤 toast） | 在 toast 加「重試失敗段落」 | P7 |
| W28 | 全域主開關（停止所有新請求並取消進行中的請求） | **沒有** | popup 開關，所有翻譯入口先檢查 | P7 |
| W29 | 請求限制：並行數、每秒 / 每分鐘請求數、逾時；可依服務或模型個別設定 | **部分有**（`maxConcurrentBatches`、`maxRetries`、429 退避、自訂模型逾時） | P1 的引擎註冊表內建 token bucket，各引擎可設 RPS / RPM | P1 |
| W30 | 網頁郵件辨識（QQ 郵箱、163） | **沒有** | 站點 adapter，優先度低 | P9 |
| W31 | 自訂網站規則（以 CSS selector 指定文章區 / 保護區） | **沒有** | 選用的進階設定；與「內容取捨交給 prompt」的原則有張力，只開放「保護區」 | P8 |

### 2.2 劃詞、閱讀輔助與學習

| # | FluentRead 功能 | Shinkansen | 預計實作方式 | 階段 |
|---|---|---|---|---|
| S1 | 劃詞翻譯卡片：譯文、複製、朗讀、收藏、分享；可拖移、縮放；捲動或複製時自動關閉 | **沒有**（上游 SPEC §2.3 明確不做） | 新的 content script（Shadow DOM 卡片），翻譯走該功能指派的引擎（D18） | P2 |
| S2 | 觸發方式：圖示、點、直接彈出、懸停圖示、快捷鍵、僅右鍵選單；延遲可調 | **沒有** | 依你的需求另加「雙擊、長按、滑鼠中鍵」。這三種**不在 FluentRead 目前的指南中**，但照你的需求實作 | P2 |
| S3 | 兩點選取（Alt+Shift+S，點起點與終點） | **沒有** | 第二次點擊後建立原生 selection，再交給 S1 | P7 |
| S4 | 雙向劃詞翻譯（選到目標語言時自動反向） | **沒有** | 卡片內偵測語言；反向目標語言可設定 | P2 |
| S5 | 英文字典（本機 ECDICT 3,000 詞，缺詞再下載完整 3.9 MB；或線上 Youdao、Free Dictionary API、Wiktionary） | **沒有** | P2 的詞義由 AI 閱讀卡提供。本機字典另案：ECDICT 是 MIT 授權，可內建；線上字典屬於第三方服務，只在使用者選用時送出 | P7 |
| S6 | 朗讀：線上語音 / 本機語音、逐字高亮、跳轉 ±5 秒 | **沒有** | Gemini 3.8 TTS（預設 Flash-Lite）；三種播放；沒有金鑰時退回 `speechSynthesis`；IndexedDB LRU 快取 20 段。TTS 不回傳字詞時間戳，逐字高亮只能估算 | P2（逐字高亮 P7） |
| S7 | AI 閱讀卡：理解 / 詞性與句法 / 用法 / 練習；附段落上下文；可追問 | **沒有** | Gemini 文字模型，系統提示注入禁用詞與術語表（重用 `buildEffectiveSystemInstruction`）；你要求的 IPA 與重音說明一併加入 | P2 |
| S8 | 句子結構視覺化（逐片語標註句法角色與詞性，方向鍵瀏覽） | **沒有** | 要求模型輸出結構化 JSON，對齊原句後渲染；對齊失敗時退回純文字解說 | P2 |
| S9 | 解說出處引用（句尾引號標記，點了跳回原句）、重新生成、歷史 | **沒有** | 出處標記與重新生成在 P2；歷史在 P3 | P2 / P3 |
| S10 | 免費 AI 解說（Bilibili 翻譯，免金鑰） | **沒有** | 第三方非官方服務、資料流向不明，**建議不做** | P9 |
| S11 | 自訂解說指令、上下文範圍（只送選取或允許送整段） | **沒有** | 卡片設定 | P2 |
| L1 | 學習中心：收藏單字 / 片語 / 句子，附原句、網址、時間；搜尋、篩選、刪除、標記熟悉 | **沒有** | 新的擴充頁面，資料存 IndexedDB | P3 |
| L2 | 間隔複習（一輪最多 20 題，到期優先，新卡最多 10 張） | **沒有** | 依你的 Again / Hard / Good / Easy 規格，採 SM-2 變體 | P3 |
| L3 | 用法學習：理解用法、自己造句並請 AI 評語 | **沒有** | 重用 P2 的閱讀卡 | P3 |
| L4 | 閱讀歷史（問答保存 30 天） | **沒有** | IndexedDB，30 天自動清除；無痕視窗不保存 | P3 |
| L5 | 學習筆記（可選擇是否供 AI 回答參考） | **沒有** | IndexedDB；預設不送 AI | P3 |
| L6 | 閱讀材料：依文章 / 文件 / 影片分組，記住閱讀位置、繼續閱讀 | **沒有** | P3 先依來源網址分組；閱讀位置延後 | P3 / P8 |
| L7 | 在新頁面再次遇到已收藏的詞時加虛線標記 | **沒有** | CSS Custom Highlight API，預設關閉 | P8 |
| L8 | 匯出：目前清單、完整備份（可選含上下文）、Anki；JSON 匯入合併 | **沒有** | CSV 依 Anki 純文字匯入格式（Tab 分隔、`#separator` / `#html` 標頭）；JSON 匯入合併 | P3 |
| L9 | 雙語分享卡片（8 種樣式，在本機產生圖片，不上傳） | **沒有** | Canvas 在本機繪製，存檔或複製 | P7 |
| L10 | 寫作助理（Gmail / GitHub 回覆草稿，插入後由使用者自己送出） | **沒有** | 站點 adapter ＋ AI 服務，優先度低 | P8 |

### 2.3 圖片、文件、影片

| # | FluentRead 功能 | Shinkansen | 預計實作方式 | 階段 |
|---|---|---|---|---|
| I1 | 網頁圖片翻譯：懸停圖示、原圖 / 譯圖切換、文字面板對照與複製 | **沒有** | 依你的規格：本機 OCR（Tesseract.js，Apache-2.0）＋目前選擇的引擎；覆蓋層可還原 | P4 |
| I2 | 漫畫連續翻譯（支援站點、預載下 N 張、失敗頁保留原圖） | **沒有** | 依你的規格：Gemini 多模態一次取回座標、原文、譯文（`box_2d` = `[ymin, xmin, ymax, xmax]`，0–1000 正規化）；取樣底色蓋字後重繪譯文；以圖片雜湊值快取；開始前顯示預估費用 | P4 |
| I3 | 漫畫背景修補（LaMa，約 197 MB）與 PaddleOCR（約 30 MB） | **沒有** | 依你的規格改用「取樣底色覆蓋」，不下載修補模型。複雜背景的效果會比 LaMa 差，列為已知限制 | P4 |
| I4 | 區域翻譯（Shift+Z 拖曳）；辨識方式可選「模型視覺」或「本機 OCR」；AI 文字整理 | **沒有** | `tabs.captureVisibleTab` 截圖後裁切；兩種辨識方式都做（模型視覺沿用 Gemini 文字模型設定） | P4 |
| I5 | 數字、品牌名、原文保護（譯文不得蓋掉辨識出但不需翻譯的文字） | **沒有** | 渲染時避開「辨識出但不翻譯」的文字框 | P4 |
| I6 | 跨來源圖片：由背景抓取（不帶 cookie）；Pixiv 需要 Referer | **沒有** | 背景 fetch（已有 `<all_urls>`）。Pixiv 的 Referer 需要 `declarativeNetRequest`，列為選用 | P4 |
| D1 | 文件翻譯：PDF / EPUB / DOCX / HTML / TXT / Markdown / SRT / VTT / ASS | **已有** | 保留 Shinkansen 版本 | — |
| D2 | 文件格式：JSON、SSA、LRC | **部分有**（SSA 已支援，JSON 與 LRC 沒有） | 擴充 `doc-file-engine.js` / `subtitle-engine.js` | P8 |
| D3 | 線上 PDF：貼網址或從選單開啟閱讀器 | **沒有** | 背景抓取 PDF 後交給既有的 translate-doc | P8 |
| D4 | 掃描版 PDF OCR | **沒有**（上游明列不支援） | 重用 P4 的 OCR 基礎 | P8 |
| D5 | 多檔批次翻譯與 ZIP 下載 | **沒有** | 既有 pipeline 外包一層佇列；ZIP 用已內建的 fflate | P8 |
| D6 | PDF 重排版（Reflow）輸出 | **沒有** | 份量大且與既有「保留原版面」路線重疊，建議延後 | P9 |
| D7 | 閱讀器：雙語 / 原文 / 譯文檢視、校對、搜尋、暫停與續翻、最近文件 | **已有**（EPUB / DOCX 工作階段、預覽編輯、PDF 左右對照） | 保留 | — |
| D8 | Obsidian 外掛 | **沒有** | 不同產品，**建議不做** | P9 |
| V1 | YouTube / X 雙語字幕 | **已有**（另有 Google Drive，FluentRead 沒有） | 保留 Shinkansen 版本 | — |
| V2 | 優先使用人工字幕 | **已有**（`preferOriginalTrack` 與字幕軌選擇器） | 保留 | — |
| V3 | 無字幕影片產生字幕（FluentRead：X 用本機 Whisper，約 100–590 MB；或本機 vLLM 跑 Qwen3-ASR） | **沒有** | 依你的規格：YouTube 用 `gemini-3.5-transcribe-live`；X 沿用同一套模組，列為 P5 選做 | P5 |
| V4 | 字幕時間偏移（±0.5 秒一格，最多 ±10 秒） | **沒有** | 在既有 overlay 加偏移量 | P5 |
| V5 | 從影片下載字幕 SRT（原文 / 譯文 / 雙語；可先補翻缺漏） | **沒有**（只有「字幕檔翻譯」） | 從 `YT.rawSegments` 與譯文快取組出 SRT；重用 `subtitle-engine.js` 的輸出端 | P5 |
| V6 | 會議字幕（Google Meet、Teams、Zoom 網頁版） | **沒有** | 各平台各寫一個 adapter，共用 overlay | P8 |
| V7 | Udemy、Disney+ 字幕 | **沒有** | 同上 | P8 |
| V8 | 讀音標註（日文羅馬字、韓文羅馬字、拼音、俄 / 希 / 阿 / 印 / 泰轉寫；日文字典約 17.8 MB） | **沒有** | 需要 kuromoji 字典（Apache-2.0）等資源，按需下載 | P8 |
| V9 | 字幕逐字高亮（依時長估算） | **沒有** | overlay 加估算式高亮 | P8 |
| V10 | 影片句子學習面板：逐句、重播、循環、到句尾暫停、收藏句子並記錄時間 | **沒有** | 建立在 P3 學習中心與既有字幕資料上 | P8 |

### 2.4 翻譯服務

| # | FluentRead 功能 | Shinkansen | 預計實作方式 | 階段 |
|---|---|---|---|---|
| E1 | 免費翻譯服務：多個候選自動平衡或依序嘗試，有健康紀錄與冷卻 | **部分有**（只有 Google） | 依你的規格：微軟 → DeepLX → Google 備援鏈，順序可調；失敗計數與冷卻存在本機 | P1 |
| E2 | Google 翻譯（免金鑰） | **已有** | 行為不變 | — |
| E3 | 微軟翻譯（免金鑰） | **沒有** | Edge 內建翻譯用的非官方端點；另提供 Azure Translator 官方金鑰模式（E8） | P1 |
| E4 | DeepL API Free / Pro（官方） | **沒有** | `api-free.deepl.com` / `api.deepl.com`，`Authorization: DeepL-Auth-Key` | P1 |
| E5 | DeepLX（自架或公開實例；FluentRead 預設會先試 DeepL 匿名端點與公開 DeepLX） | **沒有** | **只連使用者自己填的 URL**，不預設匿名或公開端點（見 §5.1） | P1 |
| E6 | Chrome 內建 Translator（本機） | **沒有** | `Translator.availability()` / `create()`；不能在 service worker 使用，要在 content script 或 offscreen 文件執行（P1 實測後決定） | P1 |
| E7 | MyMemory | **沒有** | 官方免費 API，優先度低 | P7 |
| E8 | 雲端廠商官方 API：Google Cloud、Azure、阿里雲、騰訊雲、百度、火山引擎 | **沒有**（上游明列不支援 Cloud Translation） | P1 只做 Azure Translator（「微軟翻譯」的官方模式）；其餘各家的簽章演算法不同，排在 P7 | P1 / P7 |
| E9 | 本機模型翻譯（WebGPU：中英 239 MB、混元 1.13 GB、日英 214 MB） | **沒有** | 份量重，**建議延後** | P9 |
| E10 | Ollama / 本機 OpenAI 相容伺服器 | **已有**（自訂模型） | 保留 | — |
| E11 | 多組 AI 服務（OpenAI、Claude、DeepSeek、Gemini、Azure OpenAI 等），每組有自己的金鑰、模型、prompt | **部分有**（Gemini ＋ 一組自訂模型） | 新增「多組 OpenAI 相容端點」清單；既有的 `customProvider` 保持為第 1 組、行為不變；其他組透過 `handleTranslateCustom` 的 `cpOverrides` 參數重用 | P1 |
| E12 | Claude Messages、OpenAI / DeepSeek Responses 等非 Chat Completions 原生協定 | **沒有**（上游明示須經 OpenRouter 中轉） | 優先度低 | P7 |
| E13 | 組合翻譯：輪替 / 隨機 / 智慧，各成員有逾時 | **沒有** | P1 先做「依序備援」（E1）；輪替與智慧策略在 P7 | P1 / P7 |
| E14 | 多把 API 金鑰輪替 | **沒有** | P7 | P7 |
| E15 | 自訂請求標頭；依網域移除 Origin / Referer | **部分有**（自訂模型有 `extraBodyJson`，沒有 header） | 自訂 header 在 P7；移除 Origin 需要 `declarativeNetRequest`，列為選用 | P7 |
| E16 | Gemini 代理 URL（可用 `{key}` 範本把金鑰放進 URL） | **沒有** | 與「key 不放 URL」的規則衝突，**`{key}` 範本不做**；只開放自訂 base URL，仍用 header 帶 key | P7 |
| E17 | 本機 ACP agent bridge（Copilot CLI / OpenCode） | **沒有** | 需要另外執行本機程式，**建議不做** | P9 |
| E18 | ChatGPT 方案登入 | **沒有** | FluentRead 自己都尚未開放，**不做** | P9 |
| E19 | Doubao Web、Reverso 等實驗性免費端點 | **沒有** | 非官方、匿名存取、資料政策不明，**建議不做** | P9 |
| E20 | 依功能指派服務（網頁 / 懸停 / 劃詞 / 文件 / 字幕 / 閱讀卡） | **部分有**（3 組 preset；字幕可另選引擎；文件沿用 preset） | 新功能（劃詞、閱讀卡、圖片、區域、ASR）各有「沿用預設或另選」設定 | P1 |
| E21 | AI 多段落批次翻譯 | **已有**（預設分批） | 保留 | — |
| E22 | 翻譯快取 | **已有**（LRU 9.5 MB） | 保留；新引擎沿用同一快取並以引擎 id 分區 | P1 |
| E23 | 術語表：多組、匯入匯出 CSV / TSV / JSON、內建領域術語表、大小寫、網站範圍、比對預覽 | **部分有**（全域＋網域 / 路徑兩層；CSV 匯入只在文件翻譯） | 比對預覽、大小寫、TSV / JSON 匯入在 P7 | P7 |
| E24 | 術語表也套用在機器翻譯 | **部分有**（只套用在 LLM 引擎；Google 路徑完全不套用） | 用各服務的官方機制：DeepL glossary API、微軟 dynamic dictionary。Google 免費端點沒有對應機制，列為限制。**不做譯後 regex 取代**（遵守上游原則） | P7 |
| E25 | 禁用詞清單 | Shinkansen 獨有 | 保留；MT 引擎無法用 prompt 注入，也不做事後取代 | — |

### 2.5 設定、備份與統計

| # | FluentRead 功能 | Shinkansen | 預計實作方式 | 階段 |
|---|---|---|---|---|
| C1 | 本機完整備份：可勾選是否包含 API 金鑰與詞彙上下文 | **部分有**（匯出 JSON，固定不含金鑰） | 擴充成可勾選「包含 API 金鑰」（預設不勾），P3 後可勾選「包含學習資料」；匯入沿用 `sanitizeImport` | P1 / P3 |
| C2 | WebDAV 雲端備份：測試連線、預覽差異、還原 / 上傳 / 逐項合併、刪除雲端備份、ETag 防覆寫 | **沒有** | 依你的規格。我另外建議：勾選包含金鑰時，**用使用者自訂的密語加密**（WebCrypto AES-GCM ＋ PBKDF2）。FluentRead 用固定公開密語加密，形同未加密 | P1 |
| C3 | Google Drive 備份（`drive.appdata`，只存取隱藏的應用程式資料夾） | **沒有** | 依你的規格列為選做。用 `chrome.identity` 需要**你自己建立的 Google Cloud OAuth client**，以及固定的擴充功能 ID（見 §5.3 R-9） | P1（選做） |
| C4 | 設定歷史（最近變更、前後值對照）與每 6 小時自動快照 | **沒有** | `storage.onChanged` 記錄差異；快照存 local | P7 |
| C5 | 翻譯統計：請求數、成功率、平均與 P95 延遲、快取命中、各服務效能、免費路由 | **部分有**（只有 token 與費用，沒有延遲與成功率） | P1 讓新引擎記錄 engine、延遲與成功或失敗；完整統計頁在 P7 | P1 / P7 |
| C6 | AI 用量（各模型的輸入、輸出、快取 token） | **已有** | P1 擴充：音訊 token、圖片 token、新模型；沿用既有圖表與 CSV | P1 |
| C7 | 設定搜尋 | **沒有** | P7 | P7 |
| C8 | 介面淺色 / 深色主題 | **沒有**（上游 SPEC §2.3 明確不做） | P7 | P7 |
| C9 | 介面語言與目標語言分開設定 | **已有**（8 種介面語言） | 保留 | — |
| C10 | 更多目標語言 | **部分有**（8 種目標語言；每種語言各有 prompt） | MT 引擎可支援更多語言，但 LLM prompt 只有 8 種。P8 再評估 | P8 |

### 2.6 其他平台

| # | FluentRead 功能 | Shinkansen | 預計實作方式 | 階段 |
|---|---|---|---|---|
| X1 | Userscript（Tampermonkey、Via、Safari Userscripts） | **沒有** | 不同產品，**建議不做** | P9 |
| X2 | Thunderbird 郵件翻譯外掛 | **沒有** | 不同產品，**建議不做** | P9 |
| X3 | Zotero 文獻翻譯外掛 | **沒有** | 不同產品，**建議不做** | P9 |
| X4 | Safari 原生擴充 / 行動版 | **已有**（上游有 macOS 與 iOS 版） | 依你的指示：不維護，但保留目錄 | — |
| X5 | 離線 zip 安裝 | **已有** | 保留；改名後的發行檔名在 P1 處理 | P1 |

## 3. 你列出的已知缺口：核對與補全

| 你的項目 | 核對結果 | 補全（FluentRead 有、你沒列到的部分） | 對照 |
|---|---|---|---|
| 劃詞翻譯卡片（含複製、朗讀） | 屬實。上游 SPEC §2.3 把「劃詞翻譯」列為**明確不做**，fork 要在 SPEC 加註 | 收藏、分享卡片、雙向翻譯、英文字典、拖移與縮放、捲動時自動關閉、多種觸發方式 | S1–S5 |
| AI 閱讀卡 | 屬實 | 四種動作（理解 / 詞性與句法 / 用法 / 練習）、逐片語句法視覺化、出處引用標記、重新生成、可設定上下文範圍與自訂指令、歷史 30 天 | S7–S11 |
| 學習中心 | 屬實 | 閱讀歷史、學習筆記、閱讀材料與閱讀位置、造句回饋、再次遇見標記、JSON 匯入合併 | L1–L8 |
| 圖片與螢幕區域翻譯 | 屬實（上游連掃描版 PDF 都不支援） | 模型視覺辨識模式、AI 文字整理、數字與品牌保護、文字面板、跨來源圖片、漫畫連續翻譯與預載 | I1–I6 |
| 更多翻譯引擎 | 屬實 | MyMemory、雲端廠商官方 API、本機模型、組合翻譯三種策略、多把金鑰輪替、自訂 header、RPS / RPM 限制、依功能指派服務 | E1–E20、W29 |
| 滑鼠觸發 | 部分屬實。FluentRead **目前**的指南列的劃詞觸發是：圖示、點、直接彈出、懸停圖示、快捷鍵、僅右鍵；**雙擊、長按、滑鼠中鍵不在現行指南內**。照你的需求仍實作 | 兩點選取（Alt+Shift+S）。「按住快捷鍵拖曳選取區域」對應 FluentRead 的區域翻譯（Shift+Z 後拖曳）與區段翻譯的拖曳 | S2、S3、I4、W4 |
| 段落級還原 | 屬實（上游只能整頁還原） | 段落複製 Alt+C；懸停翻譯按同一鍵切換翻譯與還原 | W6–W8 |
| 設定雲端備份 | 屬實（上游只有本機 JSON，不含金鑰） | 基本 / 敏感範圍分離、預覽與逐項合併、刪除雲端備份、設定歷史與自動快照 | C1–C4 |
| 智慧重點標示 | 屬實 | 兩種模式；Surprisal 模式需要本機約 490 MB 模型 | W12、W13 |
| 自訂翻譯樣式與選單佈局 | 部分屬實（上游有 4 種雙語標記與強調色） | 六類樣式、模糊或塗黑到懸停才顯示、白名單式自訂 CSS、具名樣式、介面主題 | W15、W16、C8 |

**你沒列到、但 FluentRead 有的其他缺口**：區段翻譯與記住區段（W4、W5）、輸入框翻譯（W9）、翻譯中心與側邊欄（W10、W11）、雙語句子高亮（W14）、網站偏好、跳過語言、主開關（W20、W21、W28）、依閱讀位置翻譯（W3）、AI 上下文（W24）、個人校訂（W25）、論文網站捷徑（W26）、分享卡片（L9）、寫作助理（L10）、會議字幕與 Udemy / Disney+（V6、V7）、字幕時間偏移與下載（V4、V5）、讀音標註、逐字高亮、句子學習面板（V8–V10）、文件 JSON / LRC、線上 PDF、掃描 PDF、批次（D2–D5）、翻譯統計（C5）、設定搜尋與主題（C7、C8）。

## 4. 階段安排

### 4.1 你定義的第 1–6 階段（範圍依上表微調）

| 階段 | 範圍 | 我補進來的項目 |
|---|---|---|
| P1 引擎與基礎設施 | 引擎註冊表；微軟（免金鑰＋Azure）、DeepL、DeepLX、Chrome Translator、多組 OpenAI 相容端點；免費引擎備援鏈；WebDAV 備份（Google Drive 選做）；用量擴充（音訊 / 圖片 token、新模型、新引擎延遲）；**改名** | W22 手動來源語言、W29 RPS / RPM 限制、E20 依功能指派服務、C1 匯出可選含金鑰、改名相關（update-check、字型來源、gecko id，見 §5.3 R-7） |
| P2 劃詞卡片、發音、AI 閱讀卡 | S1、S2、S4、S6、S7、S8、S9（出處與重新生成）、S11；W6–W8 段落級還原與複製 | W18 右鍵翻譯選取文字與本頁 |
| P3 學習中心 | L1–L6（閱讀位置除外）、L8；C1 備份可選含學習資料 | S9 閱讀歷史 |
| P4 圖片、區域、漫畫 | I1–I6 | W18 右鍵翻譯圖片 |
| P5 無字幕影片 ASR | V3（YouTube）；X 為選做 | V4 字幕時間偏移、V5 字幕下載 |
| P6 即時配音 | 依你的規格 | — |

### 4.2 建議新增的階段（請確認）

| 階段 | 範圍 |
|---|---|
| **P7 閱讀體驗與服務補完** | W2、W3、W4、W5、W9、W10、W11、W12、W14、W15、W16、W20、W21、W23、W24、W27、W28；S3、S5、S6 逐字高亮；L9；E7、E8（其餘雲端廠商）、E12、E13（輪替 / 智慧）、E14、E15、E16（只開放 base URL）、E23、E24；C4、C5（完整統計頁）、C7、C8 |
| **P8 影片、文件、學習延伸** | W25、W26、W31；L6 閱讀位置、L7、L10；D2、D3、D4、D5；V6–V10；C10 |
| **P9 建議不做或延後（需要你逐項決定）** | W13 Surprisal 模式（490 MB 本機模型）、W30 網頁郵件、S10 免費 AI 解說（Bilibili）、D6 PDF Reflow、D8 Obsidian、E9 本機翻譯模型、E17 ACP bridge、E18 ChatGPT 方案、E19 Doubao Web / Reverso、X1 Userscript、X2 Thunderbird、X3 Zotero |

## 5. 風險

### 5.1 依賴非官方端點的功能

| 功能 | 端點 | 風險 | 我的建議 |
|---|---|---|---|
| Google 翻譯（既有） | `translate.googleapis.com`（網頁版翻譯用的端點） | 無 SLA，隨時可能改版或限流（上游已在設定頁標註） | 維持現狀，P1 統一加上「可能失效、無 SLA」標籤 |
| 微軟翻譯（免金鑰） | `edge.microsoft.com/translate/auth` 取得 JWT，再呼叫 `api-edge.cognitive.microsofttranslator.com/translate` | 這是 Edge 瀏覽器內部使用的端點，非公開 API；token 格式或來源檢查可能改變 | 標註非官方；另提供 Azure Translator 官方金鑰模式 |
| DeepLX | 社群重新實作的 DeepL 網頁版介面；公開實例由不明第三方營運 | 違反 DeepL 網頁服務條款的風險；公開實例可能記錄送出的內容 | **不內建任何公開實例或 DeepL 匿名端點**，只連使用者自己填的 URL，並在設定頁說明 |
| YouTube 字幕（既有） | MAIN world 攔截 `/api/timedtext` | 播放器改版可能失效 | 維持上游做法 |
| 漫畫網站讀取器 | MANGA Plus、Pixiv 等站點的圖片與 DOM 結構 | 改版即失效；Pixiv 圖片需要 Referer；付費或登入內容受網站限制 | P4 先做通用的 `<img>` / `<canvas>` 偵測，站點 adapter 越少越好 |
| Gemini ephemeral token | 官方 API，但標示為 **preview** | 介面可能變動 | P5 / P6 依賴它（見 §5.3 R-3） |
| Gemini 預覽模型 | `gemini-3.5-live-translate-preview` | 可能改名或下架 | 模型 ID 集中在計價表與設定，不寫死在程式中 |
| Chrome 內建 Translator | 官方 Web API | 依 Chrome 版本、裝置、企業政策而定；首次使用某語言對時需要下載模型 | 偵測不可用時在設定頁說明，並自動退回備援鏈 |
| （不採用）Doubao Web、Reverso、Bilibili 免費 AI、DeepL 匿名端點、Youdao 等線上字典 | — | 非官方、匿名存取、資料政策不明 | 見 P9 |

### 5.2 需要新增的 manifest 權限

目前已有：`storage`、`alarms`、`webNavigation`；host：`<all_urls>`、Gemini、Google 翻譯、Instapaper。

| 權限 | 階段 | 用途 | Chrome | Firefox | 建議 |
|---|---|---|---|---|---|
| `contextMenus` | P2 | 右鍵「翻譯選取文字」「翻譯本頁」（P4 加「翻譯圖片」） | 支援 | 支援（`menus`） | 必要權限 |
| `offscreen` | P5（P1、P4 可能用到） | 處理分頁音訊（`AudioContext`、PCM 轉換、WebSocket）；若 content script 不能用 Chrome Translator，也在這裡執行；可能用於 OCR worker | 支援 | **不支援**（Firefox 的 background 是 event page，本身有 DOM，不需要） | 必要權限，Firefox build 用 jq 剔除 |
| `tabCapture` | P5、P6 | 擷取影片分頁的音訊 | 支援 | **不支援** | P5、P6 只支援 Chrome；Firefox build 剔除 |
| `identity` | P1（選做） | Google Drive 備份的 OAuth | 支援（另需 manifest `oauth2.client_id` 與固定的 `key`） | 部分支援（只能用 `launchWebAuthFlow`） | 放 `optional_permissions`，使用者啟用 Drive 時才請求 |
| `sidePanel` | P7 | 側邊欄翻譯 | 支援 | 不支援（Firefox 改用 `sidebar_action` manifest key） | P7 再加 |
| `declarativeNetRequestWithHostAccess` | P4（選做）、P7（選做） | Pixiv 圖片補 Referer；移除自架 API 拒絕的 Origin | 支援 | 支援 | 選用，放 `optional_permissions` |
| `unlimitedStorage` | P3、P4（視需要） | 學習資料、OCR 語言包、TTS 音訊快取放在 IndexedDB 與 Cache Storage | 支援 | 支援 | 先不加；實測配額不夠時再加 |
| host：`api.deepl.com`、`api-free.deepl.com`、`edge.microsoft.com`、`api-edge.cognitive.microsofttranslator.com`、`api.cognitive.microsofttranslator.com`、`www.googleapis.com` | P1 | DeepL、微軟、Azure、Drive | `<all_urls>` 已涵蓋；照上游慣例明列以便審查 | Firefox 的 `<all_urls>` 需要使用者授權，WebDAV 與 DeepLX 的自訂網址都靠它 | 明列 |
| `content_security_policy.extension_pages` 加 `'wasm-unsafe-eval'` | P4 | Tesseract.js（以及可能的 ONNX Runtime）需要 WebAssembly | 需確認 MV3 預設 CSP 是否已允許 | 同左 | P4 實測後決定 |
| `commands` | — | 新快捷鍵（區域翻譯、段落還原等） | Chrome 的 4 個建議快捷鍵名額已被上游用完 | — | **不改 manifest**；新快捷鍵走上游的頁內比對機制（`content-shortcuts.js`） |

### 5.3 其他技術與流程風險

| # | 風險 | 影響 | 建議 |
|---|---|---|---|
| R-1 | **上游的測試在私有 repo**（`.gitignore` 註明 2026-08-06 移到 `jimmysu0309/Shinkansen-test`，我用你的 gh 帳號查不到這個 repo）。公開 clone 裡沒有 `test/` | 「既有的 jest / playwright 測試全部通過」無法驗證 | 見 §6 決定 2 |
| R-2 | 這台機器**沒有安裝 Node.js**（只有 bun 1.4.4）。我用 bun 跑還原出來的舊版 jest：43 個測試檔有 28 個通過，但我查看的失敗案例是 bun 對 `require()` ES module 的處理不同，並非程式問題，所以這個數字**不能當作基準** | 無法建立測試基準 | 見 §6 決定 2 |
| R-3 | **Live API 的 WebSocket 憑證只能放在 URL**：官方範例是 `wss://…BidiGenerateContent?key=…`。瀏覽器的 `WebSocket` 不能設定自訂 header，所以「key 放在 `x-goog-api-key` header」做不到 | 與你的硬性規則衝突（P5、P6） | 先用 header 帶 key 呼叫 `POST /v1beta/auth_tokens`，換一個**單次使用、短效、綁定模型與設定**的 ephemeral token，WebSocket 只帶這個 token（`access_token=` 參數）。真正的 API key 永遠不會出現在 URL。這個 API 目前是 preview |
| R-4 | `gemini-3.5-transcribe-live` **不提供字詞時間戳**（只有 utterance 層級），單一 session 上限 10 分鐘 | 字幕時間軸只能用「送出音訊當下的影片時間」對齊，會比原音晚數秒；無法像既有字幕路徑那樣提前翻譯 | 第 9 分鐘左右開新連線、重疊送音數秒後去重；字幕顯示採「即時」模式，與既有的「預先翻譯」模式分開 |
| R-5 | `chrome.tabCapture` 必須在**使用者操作擴充功能之後**才能取得串流（點工具列圖示、快捷鍵、右鍵選單） | 「沒有字幕時自動啟用」無法完全自動，至少要使用者點一次 | 偵測到沒有字幕時顯示「產生 AI 字幕」按鈕，點一次之後同分頁持續有效。P5 實作時驗證 |
| R-6 | 影片廣告、倍速播放、拖曳進度 | 廣告內容會被轉錄並計費；倍速會讓時間對齊偏差 | 偵測 YouTube 廣告狀態時暫停送音；轉錄結果依 videoId 與時間區段快取，拖回已轉錄段落時不重新計費 |
| R-7 | **改名不只是換字串**：manifest gecko id `shinkansen@jimmy.zm.su` 與原版相同；`lib/update-check.js` 會查上游 Releases 並提示「有新版」；`lib/font-loader.js` 從上游的 GitHub Pages 下載字型；`lib/i18n.js` 有 64 處、HTML 有 11 處、`_locales` 有 16 處「Shinkansen」 | 不處理會與原版衝突、誤導使用者去裝原版、占用上游頻寬 | P1：改 gecko id、update-check 改查 fork、字型改從 fork 的 Pages 下載（或保留上游來源，請你決定）、使用者看得到的名稱一律換掉；內部識別字不改 |
| R-8 | **與原版 Shinkansen 同時安裝**：兩者共用 `<shinkansen-translation>` 等 DOM 標記與「同頁多份時版本最高的翻譯、其餘讓位」機制 | 兩個擴充互相讓位或互相干擾 | 文件註明不要同時啟用；改內部標記會造成大量合併衝突，不建議改 |
| R-9 | Google Drive 備份需要 OAuth client | 你必須在 Google Cloud 建立 OAuth client，並在 manifest 放入固定的 `key`，載入未封裝時的擴充功能 ID 才會固定 | 列為選做；WebDAV 不需要這些 |
| R-10 | `chrome.storage.sync` 總量 100 KB、單一 key 8 KB；`storage.local` 幾乎被翻譯快取的 9.5 MB 占滿 | 多組 AI 服務、讀音表、學習資料、音訊快取放不下 | 金鑰與大型資料放 local 或 IndexedDB；TTS 音訊快取與學習中心用 IndexedDB，OCR 語言包用 Cache Storage |
| R-11 | **TTS 促銷價**：3.8 Flash TTS 與 Flash-Lite TTS 的價格到 2026-12-31 為止，**2027-01-01 起加倍**（Flash：輸入 1.00 / 輸出 18.00；Flash-Lite：輸入 1.00 / 輸出 12.00）。上游的 `gemini-3.8-flash` 也有同樣情形 | 計價表約 7 週後就會過時 | P1 讓計價表支援「生效日期」；這也能一併處理上游的 3.8 Flash |
| R-12 | **`/IPA/` 讀音語法未見於官方文件**：模型頁、speech-generation 指南與 9 MB 的完整文件都沒有提到 IPA 或音標語法。開發者指南是 JS 渲染頁，我抓不到。3.8 TTS 會把輸入當逐字稿照唸，斜線與音標可能被直接唸出來 | 第 2 階段「自訂讀音表」可能無法照規格做 | P2 開頭先用你的金鑰實測；若不支援，改用「拼讀式改寫」（例如把 `GIF` 寫成 `jif`），讀音表仍然可以維護。**第 2 階段結果**：開發環境沒有金鑰，未實測；兩種寫法都做，設定頁每列可試聽（FORK-NOTES §6.1） |
| R-13 | Live Translate 的輸入是 16 kHz PCM、輸出是 24 kHz PCM；語音複製可能飄移；背景音樂可能產生雜音 | 譯音品質不穩 | 列為已知限制 |
| R-14 | 漫畫：Gemini 的 `box_2d` 對話框定位精度、直排日文、長條漫需要切塊、跨來源圖片要讀到像素才能重繪 | 譯文可能落在錯誤位置 | 長圖依高度切塊並保留重疊區；跨來源圖片由背景抓取；開始前顯示預估費用 |
| R-15 | i18n 工作量：上游要求所有介面字串 8 種語言都要有 | 每個新功能的字串量 × 8 | zh-TW 與 en 人工撰寫；其他 6 種用上游既有的 `tools/build/translate-i18n-dict.js`（呼叫 Gemini）產生後人工抽查。這個工具需要 Node.js |
| R-16 | 上游更新頻繁：公開測試移除後到現在已有 39 個版本；`content.js`、`background.js`、`content-youtube.js` 都是 100–260 KB 的大檔 | 合併衝突 | 嚴格執行 ARCHITECTURE-SUMMARY §10 的掛鉤原則；每個掛鉤點記錄在 FORK-NOTES |
| R-17 | Firefox：沒有 `offscreen`、`tabCapture`、`sidePanel`、Chrome Translator | P1 的 Chrome Translator、P5、P6、P7 側邊欄只能在 Chrome 使用 | Firefox build 依功能偵測隱藏這些設定，並剔除不支援的權限 |

### 5.4 與上游設計原則的衝突

| 上游原則或規格 | Fork 需求 | 處理方式 |
|---|---|---|
| SPEC §2.3「明確不做」：劃詞翻譯、DeepL 等第三方付費服務、輸入框翻譯、原文樣式客製、滑鼠懸停顯示、影片字幕（三個平台以外）、延遲載入、淺色 / 深色主題 | 這些都在你的需求或 FluentRead 的功能內 | 上游的 §2.3 不改；在 SPEC 新增一個 fork 章節，列出 fork 推翻的項目與理由 |
| 「中文用語偏好交給 prompt，不做事後 regex 取代」 | MT 引擎無法注入 prompt | 禁用詞對 MT 引擎不生效，在設定頁說明；術語表只用服務本身的官方機制，不做事後取代 |
| 「資料只送往使用者選擇的服務」 | 免費備援鏈會把同一段文字送給多家 | 備援鏈由使用者明確設定順序並啟用；設定頁說明「失敗時會改送下一家」 |
| 「內容取捨交給 LLM，content script 不做內容性排除」 | FluentRead 的自訂網站規則、全節點辨識 | 全節點辨識不做；網站規則只開放「保護區」 |
| 「不加邊框、背景等裝飾」（SPEC §4.4，單語模式） | 翻譯樣式擴充 | 新樣式只套用在雙語模式的譯文 wrapper，單語模式不變 |

## 6. 需要你決定的事項

1. **新名稱**：manifest、圖示、8 種語言的 `_locales`、i18n 字串、gecko id 都需要。
2. **測試基準**（R-1、R-2）。我建議：
   - 請你安裝 Node.js（或同意我用 `brew install node` 安裝）。
   - 把公開歷史最後一版測試（commit `8f4c2cb^`，416 個 Playwright spec＋43 個 jest 檔）還原到 fork 中並納入版控（只改 `.gitignore` 一行），先對**未修改的 v2.6.4** 跑一次，記錄原本就失敗的項目。驗收標準改為「沒有新增的失敗」，加上 fork 新功能的測試。
   - fork 自己的新測試放在獨立目錄與獨立設定檔，不和上游測試混在一起。
3. **Live API 憑證**（R-3）：是否接受「用 header 帶 key 換 ephemeral token，WebSocket URL 只帶短效 token」？若不接受，P5、P6 就沒辦法照目前的規格實作。
4. **第 7–9 階段**（§4.2）：是否照這樣排？P9 那些我建議不做的項目，哪些你仍然要做？
5. **字型來源**（R-7）：簡中 / 日 / 韓 PDF 字型繼續從上游的 GitHub Pages 下載，還是改由 fork 自己的 Pages 提供？
6. **雲端備份加密**（C2）：包含金鑰的備份，是否用使用者自訂的密語加密？（我建議要。）

### 6.1 決定紀錄（2026-11-09）

你回覆「名稱由我來想，其他照建議」，所以：

| # | 決定 |
|---|---|
| 1 | 名稱定為 **驛傳 Ekiden**。「驛傳」是日本的長距離接力賽：fork 從 Shinkansen 手上接棒，翻譯引擎的備援鏈也是一棒接一棒。名稱延續原作的日本主題，但不用新幹線的車次名稱，避免讓人誤以為是官方版本。搜尋 Chrome 線上應用程式商店與 Firefox 附加元件時，沒有找到同名的翻譯擴充功能。 |
| 2 | 用 `brew install node` 安裝 Node.js；把上游最後一版公開測試納入 fork 的版控，先在未修改的 v2.6.4 上建立基準，驗收標準為「沒有新增的失敗」；fork 的測試放在獨立目錄 |
| 3 | 接受 ephemeral token：用 `x-goog-api-key` header 換取短效、單次使用、綁定模型的 token，WebSocket URL 只帶這個 token |
| 4 | 第 7、8 階段照 §4.2 排；第 9 階段的項目全部不做 |
| 5 | PDF 字型改由 fork 自己的 GitHub Pages 提供（`docs/fonts/` 已在 repo 內） |
| 6 | 含 API 金鑰的雲端備份，用使用者自訂的密語加密（AES-GCM，金鑰由 PBKDF2 推導） |

> 本機狀態說明：為了核對測試，我在本機 clone 的 `test/` 還原了舊版測試，並用 bun 裝了 `node_modules/`。兩者都在 `.gitignore` 內，不會進入任何 commit。
