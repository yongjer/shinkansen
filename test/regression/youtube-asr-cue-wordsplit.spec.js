// Regression: youtube-asr-cue-wordsplit(v2.0.63 修的「超長 cue 硬切把英文單字
// 切成兩半」bug)
//
// Fixture: 沿用 youtube-streaming-inject.html(只需 video element + content script,
//          spec 直接驅動 SK.ASR.splitLongCue / SK._wrapTargetTextForOverlay /
//          SK._snapCutOutOfWord 純函式)
//
// Bug(real-data 2026-07-22,ticKBt_fgdE):譯文「也請考慮參加我們 9 月 1 日在倫敦
//   Union Chapel 舉辦的下一場現場演出」43 字 > ASR_CUE_MAX_CHARS(40) → 拆 2 片;
//   理想切點 22 附近 ±12 字全無標點 → 均分硬切落在「Union」內部,顯示成
//   「…倫敦 Un」+「ion Chapel 舉辦…」兩條 cue。同 pattern 也在 _wrapTargetText
//   (cue 內折行)的硬切 fallback。另外標點切點候選會選中「3.5」「p.m.」這類
//   token 內部的半形 . , : 造成同類撕裂。
//
// 修法(結構性通則):拉丁字母／數字連續 run(含夾在字母數字間的 . - 與撇號)是
//   不可分割 token——_snapCutOutOfWord 把落在 run 內的切點吸附到 run 較近一側
//   邊緣(CJK 逐字可切不受影響);_isSentencePunctAt 把夾在字母數字之間的半形
//   , . : 排除出標點切點候選。splitLongCue(顯示 cue 拆分,YT ASR + Drive 共用)
//   與 _wrapTargetText(cue 內折行)兩條路徑同套用。
//
// SANITY 紀錄(已驗證,2026-07-22):
//   破壞 1:_snapCutOutOfWord 首行插 `if (true) return cut;`(吸附失效)→ 4 case
//   全 fail:case 1「第 1 片應收在單字邊緣:『也請考慮參加我們 9 月 1 日在倫敦 Un』」
//   (正是使用者截圖症狀)、case 2 token 撕成「…GP」+「T-3.5…」、case 3 第 2 行
//   起頭「nion 教堂…」、case 4 snapLeft=5 非 3 → 還原 pass。
//   破壞 2:_isSentencePunctAt 首行插 `return _ASR_PUNCT_RE.test(t[i]);`(小數點
//   也當句間標點)→ case 2 的 2b 斷言 fail(第 1 片收在「…GPT-3.5」非「，」後)
//   → 還原 pass。
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

test.describe('youtube-asr-cue-wordsplit', () => {

  test('case 1: 硬切點落在英文單字內 → 吸附到單字邊緣(Union Chapel 不被撕成 Un|ion)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 真實案例句:43 字、全句無標點 → 走均分硬切,理想切點 22 落在「Union」內
    const longText = '也請考慮參加我們 9 月 1 日在倫敦 Union Chapel 舉辦的下一場現場演出';
    const r = await evaluate(`
      (() => {
        const pieces = window.__SK.ASR.splitLongCue(10000, 26000, ${JSON.stringify(longText)});
        return { pieces, maxChars: window.__SK.ASR_CUE_MAX_CHARS };
      })()
    `);
    expect(r.pieces.length, '43 字應拆成 2 片').toBe(2);
    expect(r.pieces[0].text.endsWith('倫敦'), `第 1 片應收在單字邊緣:「${r.pieces[0].text}」`).toBe(true);
    expect(r.pieces[1].text.startsWith('Union Chapel'), `第 2 片應以完整單字開頭:「${r.pieces[1].text}」`).toBe(true);
    // 任何相鄰片邊界都不可同時「前片尾 + 後片頭」都是拉丁字母數字(通用結構斷言)
    for (let i = 1; i < r.pieces.length; i++) {
      const tail = r.pieces[i - 1].text.slice(-1);
      const head = r.pieces[i].text[0];
      expect(/[A-Za-z0-9]/.test(tail) && /[A-Za-z0-9]/.test(head),
        `邊界不可落在單字內:「${r.pieces[i - 1].text}」|「${r.pieces[i].text}」`).toBe(false);
    }
    await page.close();
  });

  test('case 2: 夾在數字間的半形句點不是切點候選(GPT-3.5 不被撕成 GPT-3.|5)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // 45 字、唯一半形 . 在「GPT-3.5」內(位置 26,理想切點 23 的 ±12 搜尋窗內):
    // 舊邏輯把它當標點 → 切成「…GPT-3.」+「5 …」;新邏輯排除 + 硬切點吸附
    const longText = '這個新模型在許多困難的基準測試上得分遠超 GPT-3.5 而且推理速度也比先前版本快非常多';
    const r = await evaluate(`
      (() => {
        const pieces = window.__SK.ASR.splitLongCue(10000, 26000, ${JSON.stringify(longText)});
        return { pieces };
      })()
    `);
    expect(r.pieces.length, '45 字應拆成 2 片').toBe(2);
    expect(r.pieces.some(p => p.text.includes('GPT-3.5')),
      `GPT-3.5 token 必須完整留在單一片內:${JSON.stringify(r.pieces.map(p => p.text))}`).toBe(true);

    // 2b:窗內同時有 token 內小數點(較近)與真句間標點「，」(較遠)時,
    // 必須切在真標點後——小數點不可參與候選(不是「被吸附救回」而已)
    const withComma = '這個新模型在許多困難的基準測試上得分遠超 GPT-3.5，而且推理速度也比先前版本快非常多';
    const r2 = await evaluate(`
      (() => {
        const pieces = window.__SK.ASR.splitLongCue(10000, 26000, ${JSON.stringify(withComma)});
        return { pieces };
      })()
    `);
    expect(r2.pieces.length).toBe(2);
    expect(r2.pieces[0].text.endsWith('，'),
      `切點應在真句間標點後:「${r2.pieces[0].text}」`).toBe(true);
    await page.close();
  });

  test('case 3: cue 內折行硬切點也吸附到單字邊緣(_wrapTargetText 路徑)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    // video 設 800px → _calcMaxLineChars = 35(clamp 上限,決定性)
    await page.evaluate(() => { document.querySelector('video').style.width = '800px'; });

    // 33 CJK + space + Union(位置 34-38)+ space + CJK:全句無標點,
    // 折行硬切點 35 落在「Union」內 → 應吸附到 34(單字前)
    const r = await evaluate(`
      (() => {
        const cjk33 = ${JSON.stringify('這一行字幕的前段內容全部都是中文字元一共有三十三個字剛好塞滿門檻前')};
        const text = cjk33 + ' Union 教堂舉辦的活動細節說明';
        const wrapped = window.__SK._wrapTargetTextForOverlay(text);
        return { cjkLen: cjk33.length, lines: wrapped.split('\\n') };
      })()
    `);
    expect(r.cjkLen, '前綴必須是 33 個字(門檻 35 的硬切點才會落在 Union 內)').toBe(33);
    expect(r.lines.length, '52 字應折成 2 行').toBe(2);
    expect(r.lines[1].startsWith('Union'), `第 2 行應以完整單字開頭:「${r.lines[1]}」`).toBe(true);
    await page.close();
  });

  test('case 4: _snapCutOutOfWord 邊界行為(較近邊緣優先;run 佔滿區間維持原切點)', async ({ context, localServer }) => {
    const { page, evaluate } = await setupPage(context, localServer);

    const r = await evaluate(`
      (() => {
        const snap = window.__SK._snapCutOutOfWord;
        return {
          // 「倫敦 Union 教堂」:Union 佔 3-7,切點 5 距左緣 2、右緣 3 → 吸左(3)
          snapLeft: snap('倫敦 Union 教堂', 5, 0, 10),
          // 切點 6 距左緣 3、右緣 2 → 吸右(8)
          snapRight: snap('倫敦 Union 教堂', 6, 0, 10),
          // 切點兩側非同一 word run(左 CJK 右字母)→ 不動
          noTouch: snap('倫敦 Union 教堂', 3, 0, 10),
          // run 佔滿整個合法區間 → 維持原切點(寧可切也不要不拆)
          spanAll: snap('Extraordinarily', 7, 0, 15),
        };
      })()
    `);
    expect(r.snapLeft, '較近的左緣').toBe(3);
    expect(r.snapRight, '較近的右緣').toBe(8);
    expect(r.noTouch, '非 run 內切點不動').toBe(3);
    expect(r.spanAll, 'run 佔滿區間維持原切點').toBe(7);
    await page.close();
  });
});
