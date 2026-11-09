// Regression: youtube-asr-window-boundary(v2.0.54 修的「AI 分句句尾詞跨字幕重複 +
// 合句過長折三行」兩條 bug)
//
// Fixture: 沿用 youtube-streaming-inject.html(只需 content script 載入,spec 直接
//          驅動 SK._collectAsrWindowSegs / SK.ASR.splitLongCue / SK._runAsrSubBatch)
//
// Bug 1(視窗邊界,real-data 2026-07-12,cXot3z7ZPOo):ASR 視窗是純時間對齊切分
//   (floor 到 windowSizeMs),邊界常落在句中——150s 邊界正好切在「It makes 181 ⟷
//   horsepower, but…」之間。前後視窗各自獨立送 LLM:前窗腦補句尾(「181 匹馬力」),
//   後窗殘句起頭(「馬力,但…」),邊界兩側語意重複。
//   修法:_collectAsrWindowSegs 視窗末片段沒收在句尾標點時,尾端延伸收片段直到
//   句尾標點或 +ASR_WINDOW_MAX_TAIL_EXTEND_MS;asrSegConsumed 記錄已取走片段,
//   下一視窗跳過(每片段只送翻一次)。
// Bug 2(超長合句):prompt 已要求單句 ≤35 全形字,但 LLM(flash-lite)會無視,
//   50+ 字合一句 → overlay 折出 3+ 行。修法:_splitLongAsrCue code 端保底——
//   超過 ASR_CUE_MAX_CHARS 的譯文依標點均衡拆成多個顯示 cue,時間按字元占比分配;
//   只拆顯示 cue,captionMap 仍寫整句。
//
// 訊號層(驗 X 不驗 Y):本 spec 驗「收集/拆分函式邏輯 + _runAsrSubBatch 顯示寫入」,
//   不驗 translateWindowFrom 的 consumed 標記/失敗釋放時序(重依賴 config/videoEl,
//   由真實軌 probe(tools/probe-asr-llm-se-quality.mjs 延伸)+ 實機驗證涵蓋),
//   也不驗 LLM 是否真的服從「殘句不可補完」prompt 規則(LLM 行為層,fixture 化不了)。
//
// SANITY 紀錄(已驗證,2026-07-12):
//   ①暫時把 _collectAsrWindowSegs 延伸迴圈改回純時間 filter(延伸區直接 break)→
//     case A1 fail(收 4 條非 8 條、末條不含句尾標點)、case A3/A4 fail → 還原 pass。
//   ②暫時把 _splitLongAsrCue 改成無條件 return whole → case B1 fail(1 片非 2 片)、
//     case B4 fail(displayCues 1 條非 2 條)→ 還原 pass。
//   ④暫時把 _ASR_SPLIT_SNAP_MS 改 0(停用切點吸附)→ case B5 fail(切點 19962 非
//     19000)、case B4 fail(整合層切點非 8000)→ 還原 pass。
//   ③暫時把 _splitAsrSubBatches 的 _findCut 強制走 legacy findCutIdx(gap 邏輯)→
//     case A5 fail(子批 0 末片段切在句中、句 3 被切開)→ 還原 pass。
//     (子批層也是同一根因:cage 實測視窗層修好後,gap 邏輯把 146.8→152.5s 的
//     5.68s「長片段語音」誤判為停頓,重複在子批接縫重現,故子批切分同步修)
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  return { page, evaluate };
}

// 結構仿真實 ASR 軌(cXot3z7ZPOo 145-170s 區段的時間/標點結構特徵,文字改公版):
// 視窗邊界 150000 落在 seg(146800)「…It makes 181」與 seg(152480)「horsepower, but…」
// 之間;句尾標點在 seg(160800)「…any more power.」才出現。
const RAW_SEGS = [
  { startMs: 140400, text: 'being overwhelmed.',                        normText: 'a' },
  { startMs: 144080, text: 'Powering us is our good',                   normText: 'b' },
  { startMs: 146800, text: 'friend, the demo engine. It makes 181',     normText: 'c' },
  { startMs: 152480, text: 'horsepower, but because of the',            normText: 'd' },
  { startMs: 154720, text: 'featherweight status, I think that not',    normText: 'e' },
  { startMs: 157920, text: 'only does this have enough power, I',       normText: 'f' },
  { startMs: 160800, text: "don't think I want any more power.",        normText: 'g' },
  { startMs: 169200, text: 'It does not have the same wail as an old',  normText: 'h' },
];

test.describe('youtube-asr-window-boundary', () => {
  test('case A1: 視窗尾殘句 → 延伸收片段到句尾標點;下一視窗跳過已取走片段', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const r = await evaluate(`
      (() => {
        const raw = ${JSON.stringify(RAW_SEGS)};
        const consumed = new Set();
        const win1 = window.__SK._collectAsrWindowSegs(raw, 120000, 150000, consumed);
        win1.forEach(s => consumed.add(s.startMs));
        const win2 = window.__SK._collectAsrWindowSegs(raw, 150000, 180000, consumed);
        return {
          win1Starts: win1.map(s => s.startMs),
          win1LastText: win1.length ? win1[win1.length - 1].text : null,
          win2Starts: win2.map(s => s.startMs),
        };
      })()
    `);

    // 視窗 1(120-150s)不再止於 146800:延伸收 152480/154720/157920,直到句尾標點
    // 的 160800(「…power.」)為止 — 整句歸同一視窗,LLM 看得到完整句
    expect(r.win1Starts, '視窗 1 應延伸到句尾標點片段').toEqual([
      140400, 144080, 146800, 152480, 154720, 157920, 160800,
    ]);
    expect(r.win1LastText.endsWith('.'), '延伸終點必須是句尾標點片段').toBe(true);
    // 視窗 2(150-180s)跳過已被視窗 1 取走的片段,從 169200 開始(不重複送翻)
    expect(r.win2Starts, '視窗 2 不得重複收已取走片段').toEqual([169200]);

    await page.close();
  });

  test('case A2: 視窗末片段已收句尾標點 → 不延伸(維持時間邊界)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const r = await evaluate(`
      (() => {
        const raw = [
          { startMs: 1000,  text: 'first sentence here.',  normText: 'a' },
          { startMs: 29000, text: 'all wrapped up nicely.', normText: 'b' },
          { startMs: 31000, text: 'next window content',    normText: 'c' },
        ];
        return window.__SK._collectAsrWindowSegs(raw, 0, 30000, new Set()).map(s => s.startMs);
      })()
    `);
    expect(r, '句已收尾就不延伸').toEqual([1000, 29000]);

    await page.close();
  });

  test('case A3: 一直沒句尾標點 → 延伸止於 +ASR_WINDOW_MAX_TAIL_EXTEND_MS 上限', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const r = await evaluate(`
      (() => {
        const raw = [
          { startMs: 28000, text: 'no punctuation here',   normText: 'a' },
          { startMs: 33000, text: 'still going on and on', normText: 'b' },
          { startMs: 40000, text: 'more of the same',      normText: 'c' },
          { startMs: 43000, text: 'beyond the cap',        normText: 'd' },
        ];
        return {
          starts: window.__SK._collectAsrWindowSegs(raw, 0, 30000, new Set()).map(s => s.startMs),
          capMs: window.__SK.ASR_WINDOW_MAX_TAIL_EXTEND_MS,
        };
      })()
    `);
    // 上限 30000 + 12000 = 42000:收 33000/40000,43000 超限不收
    expect(r.capMs).toBe(12000);
    expect(r.starts, '無標點軌延伸須止於上限').toEqual([28000, 33000, 40000]);

    await page.close();
  });

  test('case A4: 延伸區碰到已取走片段(seek-ahead 場景)→ 停在該邊界', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const r = await evaluate(`
      (() => {
        const raw = [
          { startMs: 28000, text: 'unfinished clause with', normText: 'a' },
          { startMs: 31000, text: 'already taken by later', normText: 'b' },
          { startMs: 34000, text: 'window that ran first.', normText: 'c' },
        ];
        // 使用者先 seek 到後面:150-180s… 這裡模擬 30s 視窗先跑,31000 起已被取走
        const consumed = new Set([31000, 34000]);
        return window.__SK._collectAsrWindowSegs(raw, 0, 30000, consumed).map(s => s.startMs);
      })()
    `);
    expect(r, '延伸不得搶已被其他視窗取走的片段').toEqual([28000]);

    await page.close();
  });

  test('case A5: 子批切分——有標點軌只在句尾標點後切,假 gap(長片段語音)不切', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 7 條、句 2 橫跨 2400→10600(內含 2400→8300 的 5.9s start-to-start 間隔——
    // 那是「長片段語音」不是停頓;gap 邏輯會誤切在 8300 前,把句 2 切進兩個 LLM 呼叫)
    const r = await evaluate(`
      (() => {
        const segs = [
          { startMs: 0,     text: 'short opener sentence.' },
          { startMs: 800,   text: 'second sentence starts' },
          { startMs: 1600,  text: 'and keeps going with' },
          { startMs: 2400,  text: 'a very long spoken fragment that ends.' },
          { startMs: 8300,  text: 'third sentence with another' },
          { startMs: 9500,  text: 'long stretch of speech' },
          { startMs: 10600, text: 'that finally concludes here.' },
        ];
        // leadMs = 0(緊急):sub0Max=4000,gap 邏輯在此資料會切出跨句子批
        const batches = window.__SK._splitAsrSubBatches(segs, 0, 0, 1);
        return batches.map(b => ({
          starts: b.map(s => s.startMs),
          lastText: b[b.length - 1].text,
        }));
      })()
    `);
    // 每個非末子批的最後片段必須收在句尾標點(切點永不落在句中)
    for (let i = 0; i < r.length - 1; i++) {
      expect(
        /[.!?]["')]*$/.test(r[i].lastText.trim()),
        `子批 ${i} 末片段必須收在句尾標點,實際:「${r[i].lastText}」`,
      ).toBe(true);
    }
    // 句 3(8300/9500/10600)必須完整落在同一子批
    const batchOfThird = r.find(b => b.starts.includes(8300));
    expect(batchOfThird.starts, '句 3 不得被切開').toEqual([8300, 9500, 10600]);

    await page.close();
  });

  test('case B1: 超長譯文依標點均衡拆分,時間按字元占比、末片收原 endMs', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 55 字、含標點(仿真實案例的長度結構):應拆 2 片,切點在中點附近的標點後
    const longText = '這最後兩千三百英里的路程中我開出了每加侖超過三十六英里的平均油耗，事實上儘管我這樣開車依然維持著這個平均值';
    const r = await evaluate(`
      (() => {
        const pieces = window.__SK.ASR.splitLongCue(10000, 26000, ${JSON.stringify(longText)});
        return { pieces, maxChars: window.__SK.ASR_CUE_MAX_CHARS };
      })()
    `);
    expect(r.pieces.length, '55 字應拆成 2 片').toBe(2);
    // 每片不超過上限(均衡切,不是 40+15 的貪婪切)
    for (const p of r.pieces) {
      expect(p.text.length, `單片不得超過上限:「${p.text}」`).toBeLessThanOrEqual(r.maxChars);
    }
    // 切點落在標點後(第一片以全形逗號收尾)
    expect(r.pieces[0].text.endsWith('，'), '切點應在標點後').toBe(true);
    // 時間連續且按占比:片 0 起點=原 startMs,片尾=原 endMs,中點按字元占比
    expect(r.pieces[0].startMs).toBe(10000);
    expect(r.pieces[1].endMs).toBe(26000);
    expect(r.pieces[0].endMs).toBe(r.pieces[1].startMs);
    const ratio = r.pieces[0].text.length / longText.length;
    const expectedMid = 10000 + Math.round(16000 * ratio);
    expect(Math.abs(r.pieces[0].endMs - expectedMid), '中點應按字元占比分配').toBeLessThanOrEqual(50);

    await page.close();
  });

  test('case B5: 拆分切點吸附到片段起點(真實語音 onset),超出容差維持占比', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const longText = '這最後兩千三百英里的路程中我開出了每加侖超過三十六英里的平均油耗，事實上儘管我這樣開車依然維持著這個平均值';
    const r = await evaluate(`
      (() => {
        // 唯一逗號在第 34 字後 → 占比切點 = 10000 + 16000×34/55 ≈ 19960;
        // 片段起點 19000 在 ±2000 容差內 → 切點必須吸附到 19000
        const snapped = window.__SK.ASR.splitLongCue(10000, 26000, ${JSON.stringify(longText)}, [10000, 13000, 19000, 24000]);
        // 區間內沒有任何 onset 落在容差內 → 維持占比(不吸附到 10500 這種太遠的)
        const unsnapped = window.__SK.ASR.splitLongCue(10000, 26000, ${JSON.stringify(longText)}, [10000, 10500]);
        return {
          snapMid: snapped[0].endMs,
          snapContinuous: snapped[0].endMs === snapped[1].startMs,
          unsnapMid: unsnapped[0].endMs,
        };
      })()
    `);
    expect(r.snapMid, '切點應吸附到容差內最近的片段起點').toBe(19000);
    expect(r.snapContinuous, '吸附後前後片時間仍連續').toBe(true);
    // 無容差內 onset:維持占比切點(≈19960,不會被拉到 10500)
    expect(r.unsnapMid, '容差外不吸附,維持占比切點').toBeGreaterThan(19000);

    await page.close();
  });

  test('case B2/B3: 未超上限不拆;時長不足每片最短顯示時也不拆', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const r = await evaluate(`
      (() => {
        const short = window.__SK.ASR.splitLongCue(0, 5000, '四十字以內的正常句子不需要任何拆分處理');
        // 60 字但總時長只有 1800ms(< 2 × ASR_CUE_MIN_PIECE_MS)→ 拆了會閃跳,不拆
        const longTxt = '超長句子但是時間極短的情境下拆分會讓字幕閃跳所以寧可維持原樣讓折行處理，這一句話總共有六十個字元左右用來驗證這個防護';
        const brief = window.__SK.ASR.splitLongCue(0, 1800, longTxt);
        return { shortLen: short.length, briefLen: brief.length };
      })()
    `);
    expect(r.shortLen, '未超上限不拆').toBe(1);
    expect(r.briefLen, '時長不足不拆(避免閃跳)').toBe(1);

    await page.close();
  });

  test('case B4: _runAsrSubBatch 整合——超長句 displayCues 拆片,captionMap 仍寫整句', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const subSegs = [
      { startMs: 0,    text: 'seg one',   normText: 'seg one' },
      { startMs: 8000, text: 'seg two',   normText: 'seg two' },
      { startMs: 16000, text: 'seg three', normText: 'seg three' },
    ];
    await evaluate(`
      Object.assign(window.__SK.YT, {
        active: true,
        isAsr: false,
        videoEl: null,
        captionMap: new Map(),
        displayCues: [],
        rawSegments: ${JSON.stringify(subSegs)},
        sessionStartTime: Date.now(),
        videoId: 'test',
        config: {},
      });
    `);
    const longTrans = '這是一句遠遠超過四十個全形字元上限的超長合句譯文，用來驗證顯示層保底拆分機制，它應該被切成兩個顯示單位而快取仍保留整句';
    await evaluate(`
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_ASR_SUBTITLE_BATCH') {
          return { ok: true,
            result: ['[{"s":0,"e":17500,"t":${JSON.stringify(longTrans)}}]'],
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 } };
        }
        return { ok: true };
      };
    `);
    const r = await evaluate(`
      (async () => {
        await window.__SK._runAsrSubBatch(${JSON.stringify(subSegs)}, 0, Date.now(), [0]);
        return {
          cues: window.__SK.YT.displayCues.map(c => ({
            startMs: c.startMs, endMs: c.endMs, targetText: c.targetText,
          })),
          captionMap: Object.fromEntries(window.__SK.YT.captionMap),
        };
      })()
    `);

    expect(r.cues.length, '超長句應拆成多個顯示 cue').toBeGreaterThanOrEqual(2);
    // 拆片時間連續 + 切點吸附:片 0 起於 0;整合層切點必須等於 covered 片段起點
    // (占比中點 ≈ 8700,吸附到片段起點 8000——真實語音 onset)
    expect(r.cues[0].startMs).toBe(0);
    expect(r.cues[1].startMs, '整合層切點應吸附到 covered 片段起點').toBe(8000);
    for (let i = 1; i < r.cues.length; i++) {
      expect(r.cues[i].startMs).toBeGreaterThan(r.cues[i - 1].startMs);
    }
    // captionMap 寫整句(單一資料源:快取/注入層看到的是完整譯文)
    expect(r.captionMap['seg one'], 'captionMap 應保留整句').toBe(longTrans);
    expect(r.captionMap['seg two']).toBe('');
    expect(r.captionMap['seg three']).toBe('');

    await page.close();
  });
});
