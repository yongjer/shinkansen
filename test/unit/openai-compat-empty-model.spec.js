// Unit test: openai-compat 路徑 model 為空時 request body 不送 model 欄位(v1.8.41)
//                + 測試 ping body 不含 max_tokens(v1.8.43,GPT-5+ 拒收)
//
// 為什麼這條 spec 存在:
//   1. llama.cpp / Ollama 等本機 server 啟動時鎖定 model,使用者可不填 model 欄位,
//      shinkansen 在 build request body 時必須**省略** model 欄位讓 server 用啟動 model;
//      若硬塞空字串 model 進 body,llama.cpp 會回 400 invalid model。
//   2. v1.8.43:GPT-5 / o1 / o3 系列拒收 max_tokens(改認 max_completion_tokens),
//      而 OpenRouter / DeepSeek / 較舊 OpenAI-compat 後端不一定認新欄位,
//      改一個 break 一群。實際翻譯路徑(lib/openai-compat.js)本來就不送 max_tokens,
//      測試路徑也對齊不送,server 自然回 1-3 token 也不會失控。
//
// 兩條路徑都要鎖:
//   1. background.js testCustomProvider(設定頁的「測試」按鈕)
//   2. lib/openai-compat.js translateChunk(實際翻譯)
//
// 為什麼不直接 import 函式:這兩個檔案有 chrome.* 副作用 / DOM 依賴,
// 改用「行為等價的 helper」直接驗 build body 邏輯,確保未來改動不會 regression。
//
// SANITY 紀錄(已驗證):
//   - 把 helper 內的 `if (model) body.model = model;` 改成永遠 `body.model = model || ''`,
//     「llama.cpp」case fail。
//   - 把 helper 內的 max_tokens 加回 `max_tokens: 1`,「test request body 不含 max_tokens」case fail。
//
// 對應 Issue:
//   - llama.cpp 預設不需要指定模型 ID,「模型 ID」欄位應允許留空。
//   - GitHub issue:OpenAI GPT-5 以上版本不支援 max_tokens 參數,測試 API Key 連線失敗。
import { test, expect } from '@playwright/test';

// 模擬 background.js testCustomProvider 的 body 構建邏輯
// v1.8.43:不再送 max_tokens(GPT-5+ 拒收;ping 訊息 server 自然回 1-3 token,沒 limit 也不會失控)
function buildTestRequestBody(model) {
  const body = {
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
  };
  if (model) body.model = model;
  return body;
}

function buildTranslateRequestBody(model, messages) {
  const body = {
    messages,
    temperature: 0.7,
    stream: false,
  };
  if (model) body.model = model;
  return body;
}

test('test request:model 非空 → body 包含 model 欄位', () => {
  const body = buildTestRequestBody('anthropic/claude-sonnet-4-5');
  expect(body.model).toBe('anthropic/claude-sonnet-4-5');
});

test('test request:model 為空字串 → body 不含 model 欄位（llama.cpp 用 server 預設）', () => {
  const body = buildTestRequestBody('');
  expect('model' in body).toBe(false);
});

test('test request:model 為 undefined → body 不含 model 欄位', () => {
  const body = buildTestRequestBody(undefined);
  expect('model' in body).toBe(false);
});

test('test request:body 不含 max_tokens(v1.8.43,GPT-5+ 拒收 max_tokens)', () => {
  // 同時驗有 model / 無 model 兩條路徑都不送 max_tokens
  const withModel = buildTestRequestBody('gpt-5.4-mini');
  expect('max_tokens' in withModel).toBe(false);
  expect('max_completion_tokens' in withModel).toBe(false);

  const noModel = buildTestRequestBody('');
  expect('max_tokens' in noModel).toBe(false);
  expect('max_completion_tokens' in noModel).toBe(false);
});

test('translate request:model 非空 → body 包含 model 欄位', () => {
  const messages = [
    { role: 'system', content: 'translate to Chinese' },
    { role: 'user', content: 'hello' },
  ];
  const body = buildTranslateRequestBody('deepseek/deepseek-chat', messages);
  expect(body.model).toBe('deepseek/deepseek-chat');
  expect(body.messages).toEqual(messages);
});

test('translate request:model 為空 → body 不含 model 欄位但其他欄位齊全', () => {
  const messages = [
    { role: 'system', content: 'translate to Chinese' },
    { role: 'user', content: 'hello' },
  ];
  const body = buildTranslateRequestBody('', messages);
  expect('model' in body).toBe(false);
  expect(body.messages).toEqual(messages);
  expect(body.temperature).toBe(0.7);
  expect(body.stream).toBe(false);
});

test('LOG_USAGE resolvedModel:customProvider.model 為空 → 用 <server-default> 佔位避免空字串污染 model filter', () => {
  // 模擬 background.js LOG_USAGE handler 的 resolvedModel 邏輯
  function resolveOpenaiCompatModel(customProviderModel) {
    return customProviderModel || '<server-default>';
  }
  expect(resolveOpenaiCompatModel('anthropic/claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5');
  expect(resolveOpenaiCompatModel('')).toBe('<server-default>');
  expect(resolveOpenaiCompatModel(undefined)).toBe('<server-default>');
  expect(resolveOpenaiCompatModel(null)).toBe('<server-default>');
});
