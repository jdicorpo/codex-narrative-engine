import { requestUrl } from 'obsidian';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ConnectionTestResult,
} from '@codex-ide/core';

/**
 * Adapter for any OpenAI-compatible API. Covers:
 * - OpenAI (api.openai.com)
 * - Anthropic via OpenAI-compatible proxy
 * - Ollama (localhost:11434/v1)
 * - LM Studio (localhost:1234/v1)
 * - Any other OpenAI-compatible server
 */
export class OpenAIAdapter implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsStreaming = false;
  readonly maxContextTokens: number;

  constructor(
    id: string,
    name: string,
    private apiKey: string,
    private model: string,
    private baseUrl: string,
    maxContextTokens: number,
  ) {
    this.id = id;
    this.name = name;
    this.maxContextTokens = maxContextTokens;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const messages: { role: string; content: string }[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await requestUrl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: request.temperature ?? 0.8,
        max_tokens: request.maxTokens ?? 4096,
      }),
    });

    const data = response.json;
    const content = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage;

    return {
      content,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      } : undefined,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const result = await this.chat(request);
    yield { content: result.content, done: true };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      const url = `${this.baseUrl}/models`;
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await requestUrl({ url, method: 'GET', headers });
      const latencyMs = Date.now() - start;

      const models = response.json?.data ?? response.json?.models ?? [];
      const found = Array.isArray(models)
        ? models.find((m: Record<string, unknown>) => (m.id ?? m.name) === this.model)
        : null;

      return {
        success: true,
        message: found
          ? `Connected — model "${this.model}" available`
          : `Connected (${models.length} models available)`,
        model: this.model,
        latencyMs,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Connection failed',
        latencyMs: Date.now() - start,
      };
    }
  }
}
