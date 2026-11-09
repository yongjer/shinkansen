# Shinkansen 回歸測試建置計畫

> **狀態：✅ 已完成（v0.59，2026-04-09）**
> 全部 10 條 spec (3.1–3.10) 落地、`testInject` / `selectBestSlotOccurrences`
> debug API 已加入 `window.__shinkansen`、`localServer` fixture 已建。
> 全綠 baseline 標在 git tag `regression-baseline`。
> 8 條 inject/detect spec 都跑過 sanity check (對應 fix sabotage → 斷言精準
> 炸 → restore)。執行方式：`npx playwright test test/regression/`,
> 全套 ~13 秒。
>
> 完成清單對照:
>   - [x] 3.1 gmail-button-nested-a       (inject-gmail-button.spec.js)
>   - [x] 3.2 wiki-edo-lead-slot-dup       (inject-wiki-edo-slot-dup.spec.js)
>   - [x] 3.3 gmail-mjml-body-text         (inject-gmail-mjml-body.spec.js)
>   - [x] 3.4 wiki-ambox-maintenance-warning (inject-wiki-ambox.spec.js)
>   - [x] 3.5 wiki-br-as-paragraph         (inject-br-paragraph.spec.js)
>   - [x] 3.6 wiki-sup-reference-atomic    (inject-sup-reference.spec.js)
>   - [x] 3.7 stratechery-mixed-content-fragment (detect-stratechery.spec.js)
>   - [x] 3.8 twitter-interactive-widget-skip (detect-twitter-widget.spec.js)
>   - [x] 3.9 selectBestSlotOccurrences pure (pure-slot-dedup.spec.js)
>   - [x] 3.10 serialize-deserialize roundtrip (pure-roundtrip.spec.js)
>
> 以下原 handoff 內容保留供未來追溯動機與設計脈絡。
>
> ---
>
> 撰寫於 v0.58 之後，由解 v0.56/v0.57/v0.58 三連 bug 的 Claude 留下的 handoff。
> 下一對話（建議在 Claude Code 端執行）依這份計畫動手即可，不必重讀全部 bug 歷史。

---

## 1. 背景與動機

v0.49 到 v0.58 這段期間踩到的 bug 有一個很一致的共同特徵：**幾乎全部都落在 detect / serialize / deserialize / inject 這條路徑上，跟 LLM 本身無關**。也就是說：

- 只要把 LLM 回應當成 fixture 餵進去，就能確定性地重現每個 bug。
- 不需要花錢打 Gemini API，也不受 LLM 非決定性影響。
- 測試秒級完成，適合 pre-push hook。

現有測試基礎（勿重造輪子）：

- `test/edo-detection.spec.js`：Playwright + CDP 走 isolated world 跑真實 `collectParagraphs`。
- `test/fixtures/extension.js`：已經解決 MV3 + Playwright 的地雷（`launchPersistentContext`、`headless:false`、`--load-extension` 雙旗標、temp user data dir）。新測試直接 import 這個 fixture 就行。
- `window.__shinkansen` isolated-world debug API 已公開 `collectParagraphs / collectParagraphsWithStats / serialize / deserialize / getState`。

CDP 相關的地雷與理由請讀 `edo-detection.spec.js` 開頭的大段註解，以及 `auto-memory` 裡的 `reference_playwright_isolated_world.md`。

---

## 2. 測試分三類

每個 bug 歸到其中一類。不要跨類混用。

### 2.1 Category A — Detect/skip correctness（不需 LLM）

測「哪些元素該被翻、哪些該跳過」。用現有 `window.__shinkansen.collectParagraphsWithStats()`。

斷言對象：`units` 陣列、`skipStats` 分支命中數。

### 2.2 Category B — Inject path end-to-end（需要 canned LLM response）

測「送進 element + 假 LLM 回應 → 最終 DOM 結構」。**這類是本計畫的主菜**，因為 v0.49–v0.58 幾乎所有 bug 都在這條路徑。

需要在 `__shinkansen` 增加一個測試 helper：

```js
// 加在 content.js 的 window.__shinkansen 物件裡
testInject(el, translation) {
  const { text, slots } = serializeWithPlaceholders(el);
  const unit = { kind: 'element', el };
  injectTranslation(unit, translation, slots);
  return { sourceText: text, slotCount: slots.length };
}
```

為什麼這樣設計：`translation` 參數讓測試直接塞假 LLM 回應，`slots` 從 DOM 即時序列化拿（不 hardcode），這樣測的是真實的 `serialize → inject` 路徑，只跳過網路層。覆蓋率正好落在有 bug 的區域。

### 2.3 Category C — Pure function round-trip（純 JS，不需 Playwright）

測 `serialize` / `deserialize` / `selectBestSlotOccurrences` 等純函式。可以用 Node + jsdom 跑，完全不需要 Chrome。速度最快。

不過為了讓環境單純，也可以放進 Playwright 測試檔裡跑，反正啟動成本差不多。由實作者決定。

---

## 3. 要回歸的 bug 清單

依 SPEC.md 的 changelog 與 v0.58 時最新狀況整理。每條記錄：類別、fixture 來源、斷言要點。

### 3.1 `gmail-button-nested-a`（Category B）**最優先**

- **歷史**：v0.56 第一次修、v0.58 才真正修對。是最近連踩兩次的 bug。
- **Fixture 來源**：Gmail 裡 Claude Code welcome email 的「Learn more / 深入瞭解」按鈕 TD subtree。
- **來源結構**（簡化 sanitized）：
  ```html
  <td align="center" bgcolor="#141413" style="font-size:0;...">
    <a href="URL" target="_blank"
       style="display:inline-block;width:95px;background:#141413;...;padding:8px 35px 8px 35px;border-radius:10px">
      <span>Learn more</span>
    </a>
  </td>
  ```
  注意：TD 有 `font-size:0`，`<a>` 有 `font-size:18px`，SPAN 沒 class 沒 style（不是 preservable）。
- **Canned LLM 回應**：`⟦0⟧深入瞭解⟦/0⟧`
- **斷言**：
  1. 注入後 TD 的直接子元素 count = 1。
  2. TD 底下 `querySelectorAll('a').length === 1`（不可巢狀）。
  3. 唯一 `<a>` 的 textContent trim 後 === `深入瞭解`。
  4. `<a>.getBoundingClientRect().width` 與注入前的原始 `<a>` 寬度差異 < 2px（按鈕沒被撐大）。
  5. `<a>` 子元素不含另一個 `<a>`。
- **關鍵回歸測試**：這條若掛掉就代表 `resolveWriteTarget` 的 REJECT subtree 邏輯壞了。

### 3.2 `wiki-edo-lead-slot-dup`（Category B）

- **歷史**：v0.57 修的 slot dup graceful degradation。
- **Fixture 來源**：Wikipedia Edo 條目第一段 `<p>`，含 13+ 個 `<a>` 連結。
- **Canned LLM 回應**（實際從 console log 抓到的 v0.57 診斷訊息，保留 slot 11 dup）：
  ```
  ⟦0⟧江戶⟦/0⟧（⟦1⟧日語⟦/1⟧：⟦2⟧...⟦/2⟧...）是⟦11⟧現今日本首都⟦/11⟧⟦12⟧東京⟦/12⟧的⟦11⟧舊稱⟦/11⟧。⟦*13⟧
  ```
  完整版請從對話紀錄或實際線上重現抓。14 個 slot、slot 11 重複。
- **斷言**：
  1. 注入後 `<p>` 裡的 `<a>` 數量 >= 13（從 14 個 slot 扣掉 1 個 loser）。
  2. 13 個特定 slot 結構保留（含 slot 12、atomic 13）。
  3. Slot 11 的第一個 occurrence (`現今日本首都`) 包在 `<a>` 裡；第二個 occurrence (`舊稱`) 是純文字，**不**在 `<a>` 裡。
  4. `<sup class="reference">` atomic slot 保留 deep clone。
- **注意**：LLM 回應 fixture 要從 Chrome MCP console log 或手動複製貼出來，不是 LLM 真打的。

### 3.3 `gmail-mjml-body-text`（Category B）

- **歷史**：v0.49 修的 MJML font-size:0 body 文字消失。
- **Fixture 來源**：Gmail 同一封 Claude Code welcome email 的 step 卡片內文區（不是按鈕）。
- **來源結構**：`<td style="font-size:0"><div style="font-size:16px">step text</div></td>`
- **Canned LLM 回應**：純文字「步驟文字譯文」（無 slots）
- **斷言**：
  1. 注入後 `<td>` 底下仍有內層 `<div>`（沒被 clean slate 掉）。
  2. `<div>` 的 `getComputedStyle.fontSize === '16px'`（不是 `0px`）。
  3. `<div>.textContent` === 譯文。
- **為什麼重要**：這條是驗證 `resolveWriteTarget` 的 font-size:0 descent 路徑在「wrapper 不是 slot」的正常情況下仍然正確 fall-through 到 inner wrapper（而不是停在 td）。

### 3.4 `wiki-ambox-maintenance-warning`（Category B）

- **歷史**：v0.51–v0.54 連續三輪踩的 Wikipedia 維護警告框。v0.54 才真正修對（fragment 由 slots 重建、整段覆蓋）。
- **Fixture 來源**：Wikipedia 某個有 `.ambox` 的條目（例如 AI-generated content 標記、more footnotes needed 標記）的警告框 `<table class="ambox">`。
- **來源結構**：含巢狀 `<b><small><a>...</a></small></b>` 之類的深度序列化結構。具體 HTML 去實際 Wikipedia 頁面抓一份。
- **Canned LLM 回應**：手寫或從實際翻譯抓，關鍵是要含巢狀 slot `⟦0⟧...⟦1⟧...⟦2⟧...⟦/2⟧...⟦/1⟧...⟦/0⟧`。
- **斷言**：
  1. 注入後 DOM 結構對應 slot 巢狀（外層 B → 內層 SMALL → 內層 A）。
  2. 所有 slot 都有對應的 element shell 被 clone 回去。
  3. 譯文文字正確就位，沒有錯層。

### 3.5 `wiki-br-as-paragraph`（Category B）

- **歷史**：v0.50 修的 `<br><br><br>` 當段落分隔符（MJML email 模板常見）。
- **Fixture 來源**：一個包含 `<div>text1<br><br>text2<br><br>text3</div>` 的 synthetic HTML（不用真的從線上抓，可以手寫）。
- **Canned LLM 回應**：`譯文1\n\n譯文2\n\n譯文3`
- **斷言**：
  1. 注入後 `<div>` 裡仍有 `<br>` 元素（`\n` 正確還原為 `<br>`）。
  2. 三段譯文順序正確。
- **注意**：這條同時驗證 serializer 的 `<br>` → `\u0001` → `\n` sentinel 流程，以及 deserializer 反向還原。

### 3.6 `wiki-sup-reference-atomic`（Category B，小）

- **歷史**：atomic preserve 規則（`isAtomicPreserve`）。
- **Fixture 來源**：Wikipedia 任何含 `<sup class="reference"><a>[1]</a></sup>` 的段落。
- **Canned LLM 回應**：含 `⟦*0⟧` 自閉合原子標記的譯文。
- **斷言**：
  1. 注入後 `<sup class="reference">` deep clone 保留（含內部 `<a>`）。
  2. `[1]` 文字完全不被翻譯或全形化。

### 3.7 `stratechery-mixed-content-fragment`（Category A）

- **歷史**：v0.36 新增的 mixed-content block → fragment units。
- **Fixture 來源**：一段 `<li>引言文字<ul><li>子項目1</li><li>子項目2</li></ul></li>` 的 synthetic HTML。
- **斷言**：`collectParagraphsWithStats` 回傳的 units 含 `kind: 'fragment'` 單位（引言文字被獨立抽出），而不是整個 `<li>` 當一個 element 單位。

### 3.8 `twitter-interactive-widget-skip`（Category A）

- **歷史**：v0.39 修的 Who-to-follow UserCell。
- **Fixture 來源**：X/Twitter 的 user cell 結構（含 `role="button"` 或 `<button>` 的 block container）。可以手寫近似結構。
- **斷言**：`collectParagraphsWithStats().skipStats.interactiveWidget >= 1`，且該 block 不出現在 units 裡。

### 3.9 `selectBestSlotOccurrences` 純函式（Category C）

- **歷史**：v0.57 新增的 helper，在對話裡已經手動跑過 4 個 case。把它們寫成正式測試。
- **不需 DOM、不需 LLM**，直接呼叫 `window.__shinkansen.deserialize` 或透過一個新 exposed helper。
- **斷言**：
  - Case A：`⟦0⟧A⟦/0⟧⟦0⟧B⟦/0⟧` → winner = 第一個非空（A）
  - Case B：`⟦0⟧⟦/0⟧⟦0⟧B⟦/0⟧` → winner = 第二個（B，空殼不算 winner）
  - Case C：巢狀 `⟦3⟧⟦4⟧x⟦/4⟧⟦/3⟧` → top-level regex 不抓巢狀，不動
  - Case D：無重複 → 不動
- **注意**：`selectBestSlotOccurrences` 目前是 file-local function，需要把它加到 `__shinkansen` 物件才能從測試呼叫。

### 3.10 `serialize-deserialize-roundtrip`（Category C）

- **目的**：健康檢查，確認 serialize + 原封譯文 deserialize 能完全還原 DOM 結構。
- **Fixture**：幾個 representative HTML snippet，序列化成 `text + slots`，再用 `text` 直接（不經 LLM）當譯文跑 deserialize，比較 fragment 結構與原 DOM。
- **斷言**：tag 樹相同、text 相同、attributes 相同（至少 class + style）。

---

## 4. 檔案結構（建議）

```
test/
├── edo-detection.spec.js                # 已存在，不動
├── fixtures/
│   └── extension.js                     # 已存在，reuse
├── regression/
│   ├── fixtures/
│   │   ├── gmail-button.html            # section 3.1 的 TD subtree
│   │   ├── gmail-button.response.txt    # ⟦0⟧深入瞭解⟦/0⟧
│   │   ├── wiki-edo-lead.html           # section 3.2
│   │   ├── wiki-edo-lead.response.txt
│   │   ├── gmail-mjml-body.html         # section 3.3
│   │   ├── gmail-mjml-body.response.txt
│   │   ├── wiki-ambox.html              # section 3.4
│   │   ├── wiki-ambox.response.txt
│   │   ├── br-paragraph.html            # section 3.5（synthetic）
│   │   ├── br-paragraph.response.txt
│   │   ├── wiki-sup-ref.html            # section 3.6
│   │   ├── wiki-sup-ref.response.txt
│   │   ├── stratechery-mixed.html       # section 3.7（synthetic）
│   │   └── twitter-widget.html          # section 3.8（synthetic）
│   ├── helpers/
│   │   └── run-inject.js                # 共用：載 fixture、呼叫 testInject
│   ├── inject-gmail-button.spec.js      # section 3.1
│   ├── inject-wiki-edo-slot-dup.spec.js # section 3.2
│   ├── inject-gmail-mjml-body.spec.js   # section 3.3
│   ├── inject-wiki-ambox.spec.js        # section 3.4
│   ├── inject-br-paragraph.spec.js      # section 3.5
│   ├── inject-sup-reference.spec.js     # section 3.6
│   ├── detect-stratechery.spec.js       # section 3.7
│   ├── detect-twitter-widget.spec.js    # section 3.8
│   ├── pure-slot-dedup.spec.js          # section 3.9
│   └── pure-roundtrip.spec.js           # section 3.10
└── reports/                             # 已存在
```

---

## 5. Fixture 載入策略

Playwright 載靜態 HTML 有幾種做法，從簡到繁：

1. **`data:text/html,...` URL**：最簡單，但長 HTML 會把 URL 撐爆。小 fixture 可以。
2. **`file://` 協定 + 本地檔案**：中等。extension content script 在 `file://` 上會被載（manifest `matches: ["<all_urls>"]`），但要確認 Chrome 沒有預設 block。
3. **本地 http server**：最穩。可以用 `playwright` 內建或起一個 node `http.createServer` 在測試 setup 階段。

**建議走第 3 條**：在 `fixtures/extension.js` 加一個 `localServer` fixture，啟動時綁一個 temp port，serve `test/regression/fixtures/` 目錄。所有 spec 透過 `http://localhost:<port>/gmail-button.html` 之類的 URL 存取。好處是跟正式網頁的載入行為最接近，content script 會正常跑。

---

## 6. `testInject` helper 的 exposure

需要改 `shinkansen/content.js`。加在 `window.__shinkansen` 物件裡（約 line 1872 附近）：

```js
// 測試專用：對指定 element 跑一次完整的「serialize + 假 LLM 回應 + inject」
// 流程，回傳統計資訊。測試斷言對象是注入後的 DOM（element 本身）。
// 不觸發任何網路呼叫。
testInject(el, translation) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('testInject: el must be an Element');
  }
  const { text, slots } = serializeWithPlaceholders(el);
  const unit = { kind: 'element', el };
  injectTranslation(unit, translation, slots);
  return { sourceText: text, slotCount: slots.length };
},

// 測試專用：暴露 selectBestSlotOccurrences 給 Category C 純函式測試。
selectBestSlotOccurrences(text) {
  return selectBestSlotOccurrences(text);
},
```

加這兩個 API 本身算是 extension 結構變動，依 CLAUDE.md 硬規則 1 需要 version bump（例如加這兩個 API 就 bump 到 v0.59）。同步更新 SPEC.md 的 §2.1 標題與 changelog 說明「v0.59 新增測試專用 API `testInject` 與 `selectBestSlotOccurrences`（僅 isolated world，不污染 page 全域）」。

---

## 7. 測試執行方式

- **本地手動**：`npx playwright test test/regression/` 跑全部回歸。
- **單一 spec**：`npx playwright test test/regression/inject-gmail-button.spec.js`。
- **pre-push hook（Claude Code 端）**：加一個 `.git/hooks/pre-push` 跑回歸，失敗阻擋 push。（這條是 optional，讓實作者決定要不要加。）

---

## 8. 實作順序（建議）

務必照順序，每一步完成並通過測試後再進下一步：

1. **Step 0** — 讀 CLAUDE.md、SPEC.md（特別是 §2.1 changelog 的 v0.49–v0.58 歷史）、這份 REGRESSION_PLAN.md。
2. **Step 1** — 在 `shinkansen/content.js` 加 `testInject` 與 `selectBestSlotOccurrences` 兩個 API（第 6 節）。bump 到 v0.59，同步 manifest / test/edo-detection.spec.js EXPECTED_VERSION / SPEC.md。跑 `node --check` 確認語法，跑 `npx playwright test test/edo-detection.spec.js` 確認既有測試沒回歸。
3. **Step 2** — 擴充 `test/fixtures/extension.js`：加 `localServer` fixture（第 5 節）。
4. **Step 3** — 建 `test/regression/helpers/run-inject.js`：共用 helper，吃 `(page, fixtureUrl, responseText, targetSelector)`，回傳注入後的 element 與一些 metadata。
5. **Step 4** — 先做 **Section 3.1（gmail-button-nested-a）**。這是最近連踩兩次、最痛的 bug，先把它鎖死。Fixture HTML 可以手寫（按第 3.1 節的結構），canned response 是固定的 `⟦0⟧深入瞭解⟦/0⟧`。跑通再進下一個。
6. **Step 5** — 做 **Section 3.2（wiki-edo-lead-slot-dup）**。這條的 LLM 回應 fixture 最麻煩（要從實際 Wikipedia 抓，或從 v0.57 對話紀錄裡的 console log 複製）。
7. **Step 6** — 做 **Section 3.3 (MJML body)** 與 **3.4 (ambox)**。這兩條都是 inject 路徑，但結構比較複雜。
8. **Step 7** — 做剩下的 Section 3.5–3.10。
9. **Step 8** — 全部跑過一遍確認綠燈。commit。建議最後加一個 git tag `regression-baseline` 標記基線。

每一步都先 commit 再進下一步，方便出錯時回退。

---

## 9. 與 CLAUDE.md 硬規則的一致性

- **硬規則 1（版號）**：加 `testInject` API 算結構變動，要 bump。照 §6 做。
- **硬規則 1.5（快照 / tag）**：Claude Code 端每次 bump 記得 `git tag v<版本>`。
- **硬規則 8（結構性通則）**：每條回歸測試都應該斷言**結構特徵**（「td 底下 `<a>` 數量 = 1」「font-size 不是 0」「slot 巢狀結構對應」），不要斷言某個特定 class name 或 selector。若未來 Gmail / Wikipedia 換 class，測試不該因此掛掉——它只該在**真正的結構 bug** 發生時掛掉。

---

## 10. 已知風險與未解問題

1. **Fixture drift**：Gmail 與 Wikipedia 的實際 HTML 會隨時間變動。我們存的 fixture 是 v0.58 當時的快照，不是 live 抓取。這是故意的——fixture 必須穩定，否則測試會變成「哪天網頁改了就壞」的 flaky test。實際線上的 regression 靠手動 smoke test，自動化測試只管「曾經踩過的結構 bug 不要再犯」。
2. **Canned LLM response 不等於真 LLM 行為**：我們測的是 inject 路徑對**特定輸入**的反應，不是 LLM 品質。LLM 品質退化靠日常使用發現，不是這份計畫的責任範圍。
3. **Headless 限制**：MV3 extension 目前仍需 `headless: false`。CI 環境需要 virtual display（Xvfb）或等 Chrome 改進。
4. **`testInject` 的副作用**：會改動 DOM。每個測試應該在獨立的 page context，避免互相污染。Playwright 預設每個 test 開一個新 page，沒問題。

---

## 11. 完成的定義（DoD）

- `test/regression/` 底下所有 10 條 spec 全綠燈。
- `shinkansen/content.js` 加了 `testInject` 與 `selectBestSlotOccurrences` 兩個 API，版號 bump 到 v0.59（或當下的下一版）。
- SPEC.md §2.1 的 changelog 加一條 v0.59 說明。
- 有一個 git tag `regression-baseline` 指向全綠的那個 commit。
- 最重要：**v0.58 那條 Gmail button regression spec 掛上後，如果把 `resolveWriteTarget` 改回 v0.56 的實作（`for (const d of all)` + `continue`），這條測試必須失敗**。這是驗證測試本身有效性的 sanity check——測試若不會因為舊 bug 程式碼而失敗，就沒價值。
