// Unit test: 自訂模型 thinking 控制 mapping(v1.6.18)
//
// 各 provider thinking schema 真實依據(2026-04 校準):
//   OpenRouter: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
//   DeepSeek:   https://api-docs.deepseek.com/guides/thinking_mode
//   Claude:     https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking
//   OpenAI o:   https://developers.openai.com/api/docs/guides/reasoning
//   Grok:       https://docs.x.ai/docs/guides/reasoning
//   Qwen:       https://help.aliyun.com/zh/model-studio/deep-thinking
//
// SANITY 紀錄（已驗證）:
//   1. 把 detectProvider 對 openrouter 的判斷改成 false 後,OpenRouter 相關 spec
//      （level=off / level=high / 預設 baseUrl）三條 fail,還原後全綠。
//   2. 把 detectProvider default 從 'openai-compat-generic' 改回 'unknown' 後,
//      Fireworks / Together / Groq / DeepInfra / 自架 proxy 跑 vendor model 的 generic 行為
//      spec 全部 fail,還原後全綠。
import { test, expect } from '@playwright/test';
import {
  detectProvider, buildNativeThinking, safeParseJson, deepMerge, buildThinkingPayload,
} from '../../shinkansen/lib/openai-compat-thinking.js';

// ─── detectProvider ──────────────────────────────────────

test.describe('detectProvider: baseUrl 優先', () => {
  test('OpenRouter (預設 baseUrl)', () => {
    expect(detectProvider('https://openrouter.ai/api/v1', 'deepseek/deepseek-v4-pro')).toBe('openrouter');
    expect(detectProvider('https://OPENROUTER.AI/api/v1', 'anthropic/claude-sonnet-4-6')).toBe('openrouter');
  });

  test('DeepSeek native', () => {
    expect(detectProvider('https://api.deepseek.com/v1', 'deepseek-v4-pro')).toBe('deepseek');
  });

  test('Anthropic Claude native', () => {
    expect(detectProvider('https://api.anthropic.com/v1', 'claude-sonnet-4-6')).toBe('claude');
  });

  test('xAI Grok native', () => {
    expect(detectProvider('https://api.x.ai/v1', 'grok-4-1-fast')).toBe('grok');
  });

  test('OpenAI o-series native(baseUrl + model name 都對才 hit)', () => {
    expect(detectProvider('https://api.openai.com/v1', 'o1-mini')).toBe('openai-o');
    expect(detectProvider('https://api.openai.com/v1', 'o3')).toBe('openai-o');
    // baseUrl 是 OpenAI 但 model 不是 o-series → fallback 走通用（送 reasoning_effort，
    // 對非 reasoning model 會被 OpenAI 忽略，不會 4xx）
    expect(detectProvider('https://api.openai.com/v1', 'gpt-4o')).toBe('openai-compat-generic');
  });

  test('Qwen DashScope', () => {
    expect(detectProvider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-max')).toBe('qwen');
  });
});

test.describe('detectProvider: baseUrl 不認得 → openai-compat-generic', () => {
  // 設計理由（見 openai-compat-thinking.js JSDoc）:過去版本對未知 baseUrl 用 model 名
  // 推 vendor schema（model 含 'qwen' → 走 Qwen extra_body.enable_thinking），但實際上
  // 「未知 baseUrl」最常見的是 aggregator 或自架 OpenAI-compat proxy,這些都吃 OpenAI
  // 標準 reasoning_effort,送 vendor 原生欄位會被靜默忽略 → thinking 設定無效。
  // 改成 default 走通用 schema 後,即便 vendor 不支援 reasoning_effort 也只會被忽略,
  // 不會 4xx,比寫死 aggregator 名單更穩健。

  test('Fireworks AI 跑 vendor model（主要受影響的 case）', () => {
    expect(detectProvider('https://api.fireworks.ai/inference/v1', 'accounts/fireworks/models/qwen3p6-plus')).toBe('openai-compat-generic');
    expect(detectProvider('https://api.fireworks.ai/inference/v1', 'accounts/fireworks/models/deepseek-v4')).toBe('openai-compat-generic');
  });

  test('Together AI / Groq / DeepInfra 跑 vendor model', () => {
    expect(detectProvider('https://api.together.xyz/v1', 'qwen/qwen3-max')).toBe('openai-compat-generic');
    expect(detectProvider('https://api.groq.com/openai/v1', 'deepseek-r1-distill')).toBe('openai-compat-generic');
    expect(detectProvider('https://api.deepinfra.com/v1/openai', 'meta-llama/llama-3.3-70b')).toBe('openai-compat-generic');
  });

  test('自架 OpenAI-compat proxy（LiteLLM / 自製 server / localhost）— model 名含 vendor 關鍵字也不再被攔截', () => {
    // 過去 model 含 'qwen' / 'claude' / 'deepseek' / 'grok' 會走 vendor schema,現在一律走通用
    expect(detectProvider('https://my-proxy.local/v1', 'qwen3-flash')).toBe('openai-compat-generic');
    expect(detectProvider('https://my-proxy.local/v1', 'qwq-32b')).toBe('openai-compat-generic');
    expect(detectProvider('https://my-proxy.local/v1', 'anthropic/claude-3-5')).toBe('openai-compat-generic');
    expect(detectProvider('https://my-proxy.local/v1', 'deepseek/deepseek-v4-pro')).toBe('openai-compat-generic');
    expect(detectProvider('http://localhost:11434/v1', 'grok-4.20-multi-agent')).toBe('openai-compat-generic');
    expect(detectProvider('https://my-proxy.local/v1', 'mistral-large')).toBe('openai-compat-generic');
  });

  test('空 / null baseUrl → 預設通用', () => {
    expect(detectProvider('', '')).toBe('openai-compat-generic');
    expect(detectProvider(null, null)).toBe('openai-compat-generic');
  });
});

// ─── buildNativeThinking ──────────────────────────────────

test.describe('buildNativeThinking: auto / 各 provider × level', () => {
  test('auto 一律回 {}(不干涉 provider 預設)', () => {
    expect(buildNativeThinking('openrouter', 'auto')).toEqual({});
    expect(buildNativeThinking('deepseek', 'auto')).toEqual({});
    expect(buildNativeThinking('claude', 'auto')).toEqual({});
    expect(buildNativeThinking('grok', 'auto')).toEqual({});
    expect(buildNativeThinking('qwen', 'auto')).toEqual({});
    expect(buildNativeThinking('openai-o', 'auto')).toEqual({});
    expect(buildNativeThinking('openai-compat-generic', 'auto')).toEqual({});
  });

  test('OpenRouter: off → reasoning.exclude / level → reasoning.effort', () => {
    expect(buildNativeThinking('openrouter', 'off')).toEqual({ reasoning: { exclude: true } });
    expect(buildNativeThinking('openrouter', 'low')).toEqual({ reasoning: { effort: 'low' } });
    expect(buildNativeThinking('openrouter', 'medium')).toEqual({ reasoning: { effort: 'medium' } });
    expect(buildNativeThinking('openrouter', 'high')).toEqual({ reasoning: { effort: 'high' } });
  });

  test('DeepSeek: extra_body.thinking.type', () => {
    expect(buildNativeThinking('deepseek', 'off'))
      .toEqual({ extra_body: { thinking: { type: 'disabled' } } });
    expect(buildNativeThinking('deepseek', 'high'))
      .toEqual({ extra_body: { thinking: { type: 'enabled' } } });
  });

  test('Claude: thinking.type adaptive / disabled', () => {
    expect(buildNativeThinking('claude', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(buildNativeThinking('claude', 'high')).toEqual({ thinking: { type: 'adaptive' } });
  });

  test('OpenAI o-series: reasoning_effort minimal/low/medium/high', () => {
    expect(buildNativeThinking('openai-o', 'off')).toEqual({ reasoning_effort: 'minimal' });
    expect(buildNativeThinking('openai-o', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(buildNativeThinking('openai-o', 'high')).toEqual({ reasoning_effort: 'high' });
  });

  test('Grok: off 不送(不支援 disable,送會 400);level 直送 reasoning_effort', () => {
    expect(buildNativeThinking('grok', 'off')).toEqual({});
    expect(buildNativeThinking('grok', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(buildNativeThinking('grok', 'high')).toEqual({ reasoning_effort: 'high' });
  });

  test('Qwen: extra_body.enable_thinking', () => {
    expect(buildNativeThinking('qwen', 'off')).toEqual({ extra_body: { enable_thinking: false } });
    expect(buildNativeThinking('qwen', 'high')).toEqual({ extra_body: { enable_thinking: true } });
  });

  test('OpenAI-compat 通用:reasoning_effort none/low/medium/high(top-level,不需 extra_body 展平)', () => {
    expect(buildNativeThinking('openai-compat-generic', 'off')).toEqual({ reasoning_effort: 'none' });
    expect(buildNativeThinking('openai-compat-generic', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(buildNativeThinking('openai-compat-generic', 'medium')).toEqual({ reasoning_effort: 'medium' });
    expect(buildNativeThinking('openai-compat-generic', 'high')).toEqual({ reasoning_effort: 'high' });
  });

  test('未知 provider 字串（不在 switch case）走 default,等同 openai-compat-generic', () => {
    // default case 已合進 openai-compat-generic,所以任意未知字串都走通用 schema
    expect(buildNativeThinking('some-future-vendor', 'off')).toEqual({ reasoning_effort: 'none' });
    expect(buildNativeThinking('some-future-vendor', 'high')).toEqual({ reasoning_effort: 'high' });
  });
});

// ─── safeParseJson + deepMerge ──────────────────────────────

test.describe('safeParseJson: 容錯', () => {
  test('合法 JSON object → parse 出來', () => {
    expect(safeParseJson('{"reasoning":{"effort":"low"}}'))
      .toEqual({ reasoning: { effort: 'low' } });
  });

  test('空白 / undefined / null → {}', () => {
    expect(safeParseJson('')).toEqual({});
    expect(safeParseJson('   ')).toEqual({});
    expect(safeParseJson(undefined)).toEqual({});
    expect(safeParseJson(null)).toEqual({});
  });

  test('JSON 但不是 object(陣列 / 原始值)→ {} + 警告', () => {
    let warns = [];
    expect(safeParseJson('[1,2,3]', m => warns.push(m))).toEqual({});
    expect(warns.length).toBe(1);
    warns = [];
    expect(safeParseJson('"abc"', m => warns.push(m))).toEqual({});
    expect(warns.length).toBe(1);
  });

  test('格式錯誤 → {} + 警告(不 throw)', () => {
    let warns = [];
    expect(safeParseJson('{not json', m => warns.push(m))).toEqual({});
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('解析失敗');
  });
});

test.describe('deepMerge: 巢狀物件遞迴 merge', () => {
  test('plain object 遞迴 merge', () => {
    expect(deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } }))
      .toEqual({ a: 1, b: { c: 2, d: 3 } });
  });

  test('b 同 key 蓋 a 同 key', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('陣列由 b 覆蓋(不 concat)', () => {
    expect(deepMerge({ list: [1, 2] }, { list: [3] })).toEqual({ list: [3] });
  });

  test('a 是 plain object,b 是 primitive → b 蓋', () => {
    expect(deepMerge({ a: { x: 1 } }, { a: 'str' })).toEqual({ a: 'str' });
  });
});

// ─── buildThinkingPayload(整合) ──────────────────────────

test.describe('buildThinkingPayload: 整合', () => {
  test('OpenRouter 預設 baseUrl + level=high → reasoning.effort=high', () => {
    expect(buildThinkingPayload({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-pro',
      level: 'high',
      extraBodyRaw: '',
    })).toEqual({ reasoning: { effort: 'high' } });
  });

  test('DeepSeek native + level=off', () => {
    expect(buildThinkingPayload({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
      level: 'off',
      extraBodyRaw: '',
    })).toEqual({ extra_body: { thinking: { type: 'disabled' } } });
  });

  test('extraBodyJson 覆蓋 native mapping', () => {
    // 自動 mapping 產 reasoning.effort=high,user 進階 JSON 加 max_tokens 並改 effort=low
    expect(buildThinkingPayload({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4-6',
      level: 'high',
      extraBodyRaw: '{"reasoning":{"effort":"low","max_tokens":4000}}',
    })).toEqual({ reasoning: { effort: 'low', max_tokens: 4000 } });
  });

  test('extraBodyJson 加額外欄位(top_k 之類)', () => {
    expect(buildThinkingPayload({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3-max',
      level: 'medium',
      extraBodyRaw: '{"top_k":40}',
    })).toEqual({ reasoning: { effort: 'medium' }, top_k: 40 });
  });

  test('level=auto + extraBody 空 → 完全空物件(零干涉)', () => {
    expect(buildThinkingPayload({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-pro',
      level: 'auto',
      extraBodyRaw: '',
    })).toEqual({});
  });

  test('level=auto + extraBody 有內容 → 只用 extraBody', () => {
    expect(buildThinkingPayload({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-pro',
      level: 'auto',
      extraBodyRaw: '{"reasoning":{"max_tokens":2000}}',
    })).toEqual({ reasoning: { max_tokens: 2000 } });
  });

  test('extraBody 解析失敗 + onWarn 收到訊息 + 仍回 native mapping', () => {
    let warns = [];
    expect(buildThinkingPayload({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'grok-4.20-multi-agent',
      level: 'high',
      extraBodyRaw: '{not json',
      onWarn: m => warns.push(m),
    })).toEqual({ reasoning: { effort: 'high' } });
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('解析失敗');
  });
});
