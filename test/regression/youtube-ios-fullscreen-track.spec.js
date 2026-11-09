// Regression: v1.10.27 iOS 原生全螢幕字幕消失 → native TextTrack fallback
//
// 背景(使用者回報):iPhone / iPad Safari 看 YouTube 一按全螢幕,翻譯字幕就消失。
//   根因是 iOS 平台限制——全螢幕走 video.webkitEnterFullscreen() 進「原生播放器」,
//   只把 <video> 搬進去,所有疊在影片上的 DOM(我們的 overlay、YouTube 自己的 caption
//   div)全部被蓋住消失。連 YouTube 原生字幕在這情況也會消失。
//
// 修法(content-youtube.js iOS FS track 模組):把 displayCues 鏡像成一條 native
//   VTTCue TextTrack 掛在 <video> 上,平常 hidden(交給 DOM overlay),webkitbeginfullscreen
//   切 showing 讓原生播放器渲染,webkitendfullscreen 切回 hidden。
//
// ── 本 spec 驗到哪、沒驗到哪(CLAUDE.md 工作流原則 §3)──
//   驗到(自動,本檔):
//     - _buildIosFsTrackCues 的 cue 組裝:純譯文 = targetText、雙語 = src+'\n'+tgt、
//       ms→s 換算、endMs clamp 到下一句 startMs、無 targetText / 退化區間跳過
//     - _ensureIosFsTrack 真的在 <video> 上建出 TextTrack + 灌進對應 VTTCue
//       (Chromium 支援 addTextTrack / VTTCue,故這層可跑真實 API)
//   沒驗到(只能 iPhone 實機,進 PENDING_REGRESSION):
//     - _isIOSSafari() gate(Chromium 回 false,_refreshIosFsTrack 整段 early return)
//     - webkitbeginfullscreen / webkitendfullscreen 真實切 mode + 原生播放器渲染
//
// SANITY CHECK(已驗證):
//   - case 2 雙語:把 _buildIosFsTrackCues 內 `text = String(c.sourceText) + '\n' + text`
//     改成 `text = text`(不接原文)→ case 2 的 '\n' 斷言 fail。還原 → pass。
//   - case 3 clamp:把 `const endMs = Math.min(c.endMs, nextStart);` 改成 `c.endMs`
//     → case 3 endSec 變 6.0(原始 endMs/1000)而非 clamp 後的 4.0 → fail。還原 → pass。
//   - case 5 建軌:把 `track.addCue(new VTTCue(...))` 行 comment 掉 → cue 數變 0 → fail。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-ios-fullscreen-track';

// 共用 displayCues:三條,第二、三條故意製造「閱讀補償延長後 endMs 超過下一句 startMs」
//   cue0: 1000–2000ms
//   cue1: 2000–6000ms(endMs 6000 跨過 cue2 的 startMs 4000 → 應被 clamp 到 4000)
//   cue2: 4000–5000ms
const DISPLAY_CUES = [
  { startMs: 1000, endMs: 2000, sourceText: 'Hello world',  targetText: '哈囉世界' },
  { startMs: 2000, endMs: 6000, sourceText: 'Second line',  targetText: '第二句' },
  { startMs: 4000, endMs: 5000, sourceText: 'Third line',   targetText: '第三句' },
];

async function setup(page, bilingual) {
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`
    window.__SK.YT.displayCues = ${JSON.stringify(DISPLAY_CUES)};
    window.__SK.YT.config = { bilingualMode: ${bilingual ? 'true' : 'false'} };
  `);
  return evaluate;
}

test('case 1+3+4: 純譯文 cue 組裝 — text=targetText、ms→s、endMs clamp 到下一句、退化區間跳過', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await setup(page, false);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);

  expect(cues.length).toBe(3);
  // case 1:純譯文模式 text 只有 targetText、時間 ms→s
  expect(cues[0]).toEqual({ startSec: 1.0, endSec: 2.0, text: '哈囉世界' });
  // case 3:cue1 endMs 6000 被 clamp 到 cue2.startMs 4000 → 4.0 秒(不是 6.0)
  expect(cues[1].startSec).toBe(2.0);
  expect(cues[1].endSec).toBe(4.0);
  expect(cues[1].text).toBe('第二句');
  // cue2 最後一句無下一句,沿用自己 endMs
  expect(cues[2]).toEqual({ startSec: 4.0, endSec: 5.0, text: '第三句' });
});

test('case 2: 雙語 cue 組裝 — text = sourceText + 換行 + targetText(原文上、譯文下)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await setup(page, true);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);

  expect(cues[0].text).toBe('Hello world\n哈囉世界');
  expect(cues[1].text).toBe('Second line\n第二句');
  // 換行確實存在(原生播放器靠 \n 斷成兩行)
  expect(cues[0].text.split('\n').length).toBe(2);
});

test('case 4b: 無 targetText 的 cue 不進字幕軌', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`
    window.__SK.YT.displayCues = [
      { startMs: 1000, endMs: 2000, sourceText: 'A', targetText: '' },
      { startMs: 2000, endMs: 3000, sourceText: 'B', targetText: '有譯文' },
    ];
    window.__SK.YT.config = { bilingualMode: false };
  `);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);
  expect(cues.length).toBe(1);
  expect(cues[0].text).toBe('有譯文');
});

test('case 5: _ensureIosFsTrack 在 <video> 建出 TextTrack + 灌入對應 VTTCue', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await setup(page, false);
  const result = await evaluate(`(() => {
    const video = document.querySelector('video');
    const cues = window.__SK._buildIosFsTrackCues();
    const track = window.__SK._ensureIosFsTrack(video, cues, false);
    return JSON.stringify({
      kind: track.kind,
      mode: track.mode,
      marker: track.__skCreateBy,
      cueCount: track.cues ? track.cues.length : -1,
      firstStart: track.cues && track.cues[0] ? track.cues[0].startTime : null,
      firstEnd:   track.cues && track.cues[0] ? track.cues[0].endTime : null,
      firstText:  track.cues && track.cues[0] ? track.cues[0].text : null,
      // 再呼叫一次應 reuse 同一條軌(不重複 addTextTrack)
      trackCountAfterSecond: (window.__SK._ensureIosFsTrack(video, cues, false), video.textTracks.length),
    });
  })()`).then(JSON.parse);

  expect(result.kind).toBe('subtitles');
  expect(result.marker).toBe('shinkansen-yt-fs');
  expect(result.mode).toBe('hidden');             // showNow=false → hidden
  expect(result.cueCount).toBe(3);
  expect(result.firstStart).toBe(1.0);
  expect(result.firstEnd).toBe(2.0);
  expect(result.firstText).toBe('哈囉世界');
  // find-or-create:第二次呼叫不應再多建一條軌
  expect(result.trackCountAfterSecond).toBe(1);
});

// ── 非 ASR(原生 / 人工字幕)路徑 ───────────────────────────────────────
//
// 背景(使用者回報 v1.10.35):iPhone ASR 字幕全螢幕 OK,但原生英文字幕翻譯按全螢幕
//   消失。根因:_buildIosFsTrackCues 只讀 displayCues,而 displayCues 只有 ASR 路徑
//   (_upsertDisplayCue)會寫;非 ASR 譯文存在 captionMap(key=normText),從不進
//   displayCues → iOS FS 字幕軌組出 0 條 cue → 全螢幕空白。
//
// 修法:displayCues 為空時改從 rawSegments(時間軸 + groupId)+ captionMap(譯文)組裝。
//
// 本段驗:_buildIosFsCuesFromRawSegments 的多行 groupId 合併、captionMap join、
//   未翻 / dedup 空字串跳過、endMs 用下一單位 startMs(最後一句 +4s)、雙語 src+\n+tgt。
//   沒驗到(同上,只能 iPhone 實機):_isIOSSafari gate、全螢幕真實切換、原生播放器渲染、
//   _scheduleIosFsTrackRefresh 在非 ASR 批次完成後真的被觸發(那條走 _injectBatchResult /
//   flushOnTheFly,屬整合路徑,進 PENDING)。
//
// SANITY CHECK(已驗證):
//   - 多行合併:把 _buildIosFsCuesFromRawSegments 的 `while (... segs[j].groupId === seg.groupId)`
//     的 srcText join 改成只取 group[0].text → 雙語 case 的 'Second line wrapped' 斷言 fail。還原 → pass。
//   - 未翻跳過:把 `if (!trans) continue;` 改成 `if (false) continue;` → 未翻段也進 cue,
//     cueCount 從 2 變 3、且出現 undefined text → fail。還原 → pass。
//   - 最後一句 +4s:把 `(u.startMs + _IOS_FS_LAST_CUE_MS)` 改成 `u.startMs` → 最後 cue
//     endSec===startSec 被退化區間 `endMs > u.startMs` 擋掉 → cueCount 少一條 → fail。還原 → pass。

// rawSegments:seg0 單行、seg1+seg2 同 groupId 多行、seg3 單行
const RAW_SEGMENTS = [
  { text: 'Hello world', normText: 'hello world', startMs: 1000, groupId: null },
  { text: 'Second line', normText: 'second line', startMs: 3000, groupId: 1 },
  { text: 'wrapped',     normText: 'wrapped',     startMs: 3000, groupId: 1 },
  { text: 'Third',       normText: 'third',       startMs: 5000, groupId: null },
];

async function setupNonAsr(page, bilingual, capEntries) {
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`
    window.__SK.YT.displayCues = [];
    window.__SK.YT.rawSegments = ${JSON.stringify(RAW_SEGMENTS)};
    window.__SK.YT.captionMap = new Map(${JSON.stringify(capEntries)});
    window.__SK.YT.config = { bilingualMode: ${bilingual ? 'true' : 'false'} };
  `);
  return evaluate;
}

test('非 ASR case 1:displayCues 空 → 從 rawSegments + captionMap 組 cue(多行合併、最後一句 +4s)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  // 多行群組:第一行 key 存合併譯文,其餘存空字串(跟 captionMap 寫入慣例一致)
  const evaluate = await setupNonAsr(page, false, [
    ['hello world', '哈囉世界'],
    ['second line', '第二句'],
    ['wrapped', ''],
    ['third', '第三句'],
  ]);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);

  expect(cues.length).toBe(3);
  // unit0 單行:endMs = 下一單位 startMs 3000 → 3.0
  expect(cues[0]).toEqual({ startSec: 1.0, endSec: 3.0, text: '哈囉世界' });
  // unit1 多行群組:key=第一行,endMs = 下一單位(third)startMs 5000 → 5.0
  expect(cues[1]).toEqual({ startSec: 3.0, endSec: 5.0, text: '第二句' });
  // unit2 最後一句:無下一單位 → +4s → 9.0
  expect(cues[2]).toEqual({ startSec: 5.0, endSec: 9.0, text: '第三句' });
});

test('非 ASR case 2:未翻到(captionMap 無 key)的單位跳過', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  // 'third' 不在 captionMap → 該單位跳過(streaming 尚未翻到的尾段)
  const evaluate = await setupNonAsr(page, false, [
    ['hello world', '哈囉世界'],
    ['second line', '第二句'],
    ['wrapped', ''],
  ]);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);

  expect(cues.length).toBe(2);
  expect(cues.map(c => c.text)).toEqual(['哈囉世界', '第二句']);
});

test('非 ASR case 3:雙語 — 多行群組原文以空格 join,text = 原文 + 換行 + 譯文', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await setupNonAsr(page, true, [
    ['hello world', '哈囉世界'],
    ['second line', '第二句'],
    ['wrapped', ''],
    ['third', '第三句'],
  ]);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);

  expect(cues[0].text).toBe('Hello world\n哈囉世界');
  // 多行群組原文 join:'Second line' + ' ' + 'wrapped'
  expect(cues[1].text).toBe('Second line wrapped\n第二句');
  expect(cues[0].text.split('\n').length).toBe(2);
});

test('非 ASR case 4:captionMap 全空(尚未翻譯)→ 回空陣列,不噴錯', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await setupNonAsr(page, false, []);
  const cues = await evaluate(`JSON.stringify(window.__SK._buildIosFsTrackCues())`).then(JSON.parse);
  expect(cues.length).toBe(0);
});
