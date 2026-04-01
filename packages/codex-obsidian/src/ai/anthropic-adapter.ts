import { requestUrl } from 'obsidian';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ConnectionTestResult,
} from '@codex-ide/core';

export class AnthropicAdapter implements LLMProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic (Claude)';
  readonly supportsStreaming = false;
  readonly maxContextTokens: number;

  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string,
    maxContextTokens: number,
  ) {
    this.maxContextTokens = maxContextTokens;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/messages`;

    const messages: { role: string; content: string }[] = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') continue;
      messages.push({ role: msg.role, content: msg.content });
    }

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.8,
        system: request.systemPrompt || undefined,
        messages,
      }),
    });

    const data = response.json;
    const content = data?.content?.[0]?.text ?? '';
    const usage = data?.usage;

    return {
      content,
      usage: usage ? {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
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
      const response = await requestUrl({
        url: `${this.baseUrl}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      const latencyMs = Date.now() - start;

      return {
        success: true,
        message: `Connected to ${this.model}`,
        model: response.json?.model ?? this.model,
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
