// Unit test: OpenAI-compat customProvider.useStrongSegMarker toggle 切換段序號標記格式
//
// 動機:本機量化模型(gemma-4 量化版等)會把預設 «1» «2» 段序號當自然語言誤翻成
// 「N1, N2」洩漏到譯文。新增 toggle 預設 true,改用 <<<SHINKANSEN_SEG-N>>> 強化格式,
// 弱模型不會誤翻;商用 LLM 使用者可關閉 toggle 改回 «N» 省 token。Gemini 主路徑
// 不受影響(固定用 COMPACT)。
//
// 本 spec 驗:
//   1. toggle = true (預設):送出的 user message 含 <<<SHINKANSEN_SEG-N>>>,system
//      instruction 描述句也用 <<<SHINKANSEN_SEG-N>>>
//   2. toggle = false:送出 «N»,描述句也用 «N»
//   3. toggle = undefined (舊使用者升級):等同 true
//   4. 單段時不加任何 marker(無論 toggle)
//
// SANITY 紀錄(2026-05-07):
//   把 lib/openai-compat.js 內 marker 選擇行 `cp.useStrongSegMarker === false` 改成
//   `true === false`(永遠選 STRONG)→ 第 #2 條 fail(送出仍是 SEG-N 不是 «N»)。還原後 pass。
import { test, expect } from '@playwright/test';

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

let lastUserMessage = '';
let lastSystemMessage = '';

globalThis.fetch = async (_url, options) => {
  const reqBody = JSON.parse(options?.body || '{}');
  lastSystemMessage = reqBody.messages?.[0]?.content || '';
  lastUserMessage = reqBody.messages?.[1]?.content || '';
  // 對齊回應(避免觸發 segment mismatch fallback):輸入有幾段就回幾段
  const sepCount = (lastUserMessage.match(/<<<SHINKANSEN_SEP>>>/g) || []).length;
  const segCount = sepCount + 1;
  const respText = Array.from({ length: segCount }, (_, i) => `段譯${i + 1}`).join('\n<<<SHINKANSEN_SEP>>>\n');
  // v1.10.53: 回真實 Response(openai-compat.js 成功路徑 await resp.text() 重建,缺 .text() 會炸)
  return new Response(JSON.stringify({
    choices: [{ message: { content: respText }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 30 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { translateBatch } = await import('../../shinkansen/lib/openai-compat.js');

function makeSettings(useStrongSegMarker) {
  const cp = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-5',
    systemPrompt: 'sys',
    temperature: 0.5,
    apiKey: 'sk-test',
  };
  if (useStrongSegMarker !== 'omit') cp.useStrongSegMarker = useStrongSegMarker;
  return { customProvider: cp, maxRetries: 0 };
}

test.beforeEach(() => { lastUserMessage = ''; lastSystemMessage = ''; });

test.describe('OpenAI-compat marker toggle', () => {
  test('useStrongSegMarker=true: 送出 SEG-N STRONG 格式', async () => {
    await translateBatch(['First', 'Second', 'Third'], makeSettings(true), null, null, null);
    // user message 含 STRONG marker,不含 COMPACT
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-1>>>'), `user msg 應含 SEG-1: ${lastUserMessage.slice(0, 200)}`).toBe(true);
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-2>>>')).toBe(true);
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-3>>>')).toBe(true);
    expect(/«\d+»/.test(lastUserMessage), `user msg 不該含 COMPACT «N»: ${lastUserMessage.slice(0, 200)}`).toBe(false);
    // system instruction 描述句也用 STRONG
    expect(lastSystemMessage.includes('<<<SHINKANSEN_SEG-N>>>')).toBe(true);
    expect(lastSystemMessage.includes('«N»')).toBe(false);
  });

  test('useStrongSegMarker=false: 送出 «N» COMPACT 格式', async () => {
    await translateBatch(['First', 'Second', 'Third'], makeSettings(false), null, null, null);
    // user message 含 COMPACT marker,不含 STRONG
    expect(/«1»/.test(lastUserMessage), `user msg 應含 «1»: ${lastUserMessage.slice(0, 200)}`).toBe(true);
    expect(/«2»/.test(lastUserMessage)).toBe(true);
    expect(/«3»/.test(lastUserMessage)).toBe(true);
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-'), `user msg 不該含 STRONG SEG-N: ${lastUserMessage.slice(0, 200)}`).toBe(false);
    // system instruction 描述句也用 COMPACT
    expect(lastSystemMessage.includes('«N»')).toBe(true);
    expect(lastSystemMessage.includes('<<<SHINKANSEN_SEG-N>>>')).toBe(false);
  });

  test('useStrongSegMarker=undefined (舊使用者): 等同 true (預設 STRONG)', async () => {
    await translateBatch(['First', 'Second'], makeSettings('omit'), null, null, null);
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-1>>>'), `預設應 STRONG: ${lastUserMessage.slice(0, 200)}`).toBe(true);
    expect(/«\d+»/.test(lastUserMessage)).toBe(false);
  });

  test('單段不加任何 marker (無論 toggle)', async () => {
    await translateBatch(['Only one'], makeSettings(true), null, null, null);
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-')).toBe(false);
    expect(/«\d+»/.test(lastUserMessage)).toBe(false);
    // 只有原文,不含分隔符
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEP>>>')).toBe(false);

    await translateBatch(['Only one'], makeSettings(false), null, null, null);
    expect(lastUserMessage.includes('<<<SHINKANSEN_SEG-')).toBe(false);
    expect(/«\d+»/.test(lastUserMessage)).toBe(false);
  });
});
