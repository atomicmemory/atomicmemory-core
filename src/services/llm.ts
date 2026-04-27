/**
 * LLM provider abstraction for chat completions.
 * Supports OpenAI, Ollama, and any OpenAI-compatible API (LM Studio, etc).
 * Provider is selected via PROVIDER_LLM env var.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Agent as UndiciAgent } from 'undici';
import { retryOnRateLimit } from './api-retry.js';
import {
  estimateCostUsd,
  getCostStage,
  summarizeUsage,
  writeCostEvent,
  type WriteCostEventConfig,
} from './cost-telemetry.js';
import type { LLMProviderName } from '../config.js';

/**
 * Config subset consumed by the LLM module. Same module-local-state
 * pattern as embedding.ts: provider/model selection is startup-only
 * (Phase 7 Step 3c), so holding the config as module state after init
 * matches the effective contract.
 */
export interface LLMConfig extends WriteCostEventConfig {
  llmProvider: LLMProviderName;
  llmModel: string;
  llmApiUrl?: string;
  llmApiKey?: string;
  openaiApiKey: string;
  groqApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  ollamaBaseUrl: string;
  llmSeed?: number;
}

let llmConfig: LLMConfig | null = null;

/** Bind the LLM module's config. Called once by the composition root. */
export function initLlm(config: LLMConfig): void {
  llmConfig = config;
  provider = null;
  providerKey = '';
}

function requireConfig(): LLMConfig {
  if (!llmConfig) {
    throw new Error(
      'llm.ts: initLlm(config) must be called at composition-root time before chat. See runtime-container.ts.',
    );
  }
  return llmConfig;
}

/** Extended-timeout dispatcher for slow local models (e.g. qwen3 thinking mode). */
const ollamaDispatcher = new UndiciAgent({ headersTimeout: 300_000, bodyTimeout: 300_000 });

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  seed?: number;
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

function sanitizeTransportContent(content: string, aggressive: boolean = false): string {
  const normalized = content.normalize('NFKC');
  const cleaned = Array.from(normalized).map((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    const isAllowedWhitespace = char === '\n' || char === '\r' || char === '\t';
    const isControl = codePoint < 0x20 && !isAllowedWhitespace;
    const isDelete = codePoint === 0x7f;
    if (isControl || isDelete) return ' ';
    if (!aggressive) return char;
    if (codePoint >= 0x20 && codePoint <= 0x7e) return char;
    if (/\p{Letter}|\p{Number}/u.test(char)) return char;
    return ' ';
  }).join('');
  return cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeMessages(messages: ChatMessage[], aggressive: boolean = false): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: sanitizeTransportContent(message.content, aggressive),
  }));
}

function isJsonBodyParseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('parse the JSON body of your request');
}

/** OpenAI and any OpenAI-compatible API (LM Studio at localhost:1234/v1, etc). */
class OpenAICompatibleLLM implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    try {
      return await this.executeOpenAIRequest(messages, options, false);
    } catch (error) {
      if (!isJsonBodyParseError(error)) throw error;
      return this.executeOpenAIRequest(messages, options, true);
    }
  }

  /** Execute a single OpenAI-compatible request with optional aggressive sanitization. */
  private async executeOpenAIRequest(
    messages: ChatMessage[],
    options: ChatOptions,
    aggressiveSanitize: boolean,
  ): Promise<string> {
    const effectiveSeed = options.seed ?? requireConfig().llmSeed;
    const request = () => this.client.chat.completions.create({
      model: this.model,
      messages: sanitizeMessages(messages, aggressiveSanitize),
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
      ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...(effectiveSeed !== undefined ? { seed: effectiveSeed } : {}),
    });

    const started = performance.now();
    const response = await retryOnRateLimit(request);
    recordOpenAICost(this.model, response.usage, started);
    return response.choices[0].message.content ?? '';
  }
}

/** Record cost telemetry for an OpenAI-compatible response. */
function recordOpenAICost(
  model: string,
  responseUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  started: number,
): void {
  const config = requireConfig();
  const usage = summarizeUsage(
    responseUsage?.prompt_tokens ?? null,
    responseUsage?.completion_tokens ?? null,
    responseUsage?.total_tokens ?? null,
  );
  writeCostEvent({
    stage: getCostStage(), provider: config.llmProvider, model, requestKind: 'chat',
    durationMs: performance.now() - started, cacheHit: false,
    inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null, estimatedCostUsd: estimateCostUsd(config.llmProvider, model, usage),
  }, config);
}

/** Ollama via its native HTTP API at localhost:11434. */
class OllamaLLM implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const config = requireConfig();
    const effectiveSeed = options.seed ?? config.llmSeed;
    const body = {
      model: this.model,
      messages,
      stream: false,
      think: false,
      options: {
        temperature: options.temperature ?? 0,
        ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        ...(effectiveSeed !== undefined ? { seed: effectiveSeed } : {}),
      },
      ...(options.jsonMode ? { format: 'json' } : {}),
    };

    const started = performance.now();
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
      // @ts-expect-error -- Node.js fetch supports undici dispatcher option
      dispatcher: ollamaDispatcher,
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json() as { message: { content: string; thinking?: string }; prompt_eval_count?: number; eval_count?: number };
    const usage = summarizeUsage(data.prompt_eval_count ?? null, data.eval_count ?? null, null);
    writeCostEvent({ stage: getCostStage(), provider: config.llmProvider, model: this.model, requestKind: 'chat', durationMs: performance.now() - started, cacheHit: false, inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, totalTokens: usage.totalTokens ?? null, estimatedCostUsd: estimateCostUsd(config.llmProvider, this.model, usage) }, config);
    const content = stripThinkingTags(data.message.content);
    // Reasoning models (qwen3) put output in 'thinking' when content is empty.
    if (!content && data.message.thinking) {
      return stripThinkingTags(data.message.thinking);
    }
    return content;
  }
}

/** Strip <think>...</think> tags that reasoning models (e.g. qwen3) emit. */
function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/** Anthropic Claude API. */
class AnthropicLLM implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const config = requireConfig();
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const request = () => this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: nonSystemMsgs,
    });
    const started = performance.now();
    const response = await retryOnRateLimit(request);
    const usage = summarizeUsage(response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null, null);
    writeCostEvent({ stage: getCostStage(), provider: config.llmProvider, model: this.model, requestKind: 'chat', durationMs: performance.now() - started, cacheHit: false, inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, totalTokens: usage.totalTokens ?? null, estimatedCostUsd: estimateCostUsd(config.llmProvider, this.model, usage) }, config);
    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock?.text ?? '';
    // Strip <thinking> tags that some models produce in their text output
    return raw.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
  }
}

/** Create LLM provider from config. */
export function createLLMProvider(): LLMProvider {
  const config = requireConfig();
  switch (config.llmProvider) {
    case 'openai':
      return new OpenAICompatibleLLM(config.openaiApiKey, config.llmModel);
    case 'ollama':
      return new OllamaLLM(config.llmModel, config.ollamaBaseUrl);
    case 'groq':
      return new OpenAICompatibleLLM(
        config.groqApiKey ?? '',
        config.llmModel,
        'https://api.groq.com/openai/v1',
      );
    case 'anthropic':
      return new AnthropicLLM(config.anthropicApiKey ?? '', config.llmModel);
    case 'google-genai':
      return new OpenAICompatibleLLM(
        config.googleApiKey ?? '',
        config.llmModel,
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      );
    case 'openai-compatible':
      return new OpenAICompatibleLLM(
        config.llmApiKey ?? config.openaiApiKey,
        config.llmModel,
        config.llmApiUrl,
      );
    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
  }
}

let provider: LLMProvider | null = null;
let providerKey = '';

function getProviderKey(): string {
  const config = requireConfig();
  return [
    config.llmProvider,
    config.llmModel,
    config.llmApiUrl ?? '',
    config.ollamaBaseUrl,
  ].join('|');
}

function getProvider(): LLMProvider {
  const nextKey = getProviderKey();
  if (!provider || nextKey !== providerKey) {
    provider = createLLMProvider();
    providerKey = nextKey;
  }
  return provider;
}

/** Singleton-like LLM accessor that refreshes when runtime config changes. */
export const llm: LLMProvider = {
  chat(messages, options) {
    return getProvider().chat(messages, options);
  },
};
