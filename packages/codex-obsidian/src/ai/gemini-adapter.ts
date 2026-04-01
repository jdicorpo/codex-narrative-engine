import { requestUrl } from 'obsidian';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ConnectionTestResult,
} from '@codex-ide/core';

interface GeminiContent {
  role: string;
  parts: { text: string }[];
}

export class GeminiAdapter implements LLMProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
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
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    console.debug(`Codex AI: POST ${this.baseUrl}/v1beta/models/${this.model}:generateContent`);

    const contents = this.buildContents(request);
    if (contents.length === 0) {
      throw new Error('No messages to send');
    }

    const systemInstruction = request.systemPrompt
      ? { parts: [{ text: request.systemPrompt }] }
      : undefined;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.8,
        maxOutputTokens: request.maxTokens ?? 4096,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    try {
      const response = await requestUrl({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        throw: false,
      });

      if (response.status !== 200) {
        const errBody = typeof response.text === 'string' ? response.text : JSON.stringify(response.json);
        console.error(`Codex AI: Gemini returned ${response.status}`, errBody);
        throw new Error(`Gemini API error ${response.status}: ${response.json?.error?.message ?? errBody.slice(0, 200)}`);
      }

      const data = response.json;
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const usage = data?.usageMetadata;

      return {
        content: text,
        usage: usage ? {
          promptTokens: usage.promptTokenCount ?? 0,
          completionTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        } : undefined,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Gemini API error')) throw err;
      console.error('Codex AI: Request failed', err);
      throw new Error(`Request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const result = await this.chat(request);
    yield { content: result.content, done: true };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      const url = `${this.baseUrl}/v1beta/models/${this.model}?key=${this.apiKey}`;
      console.debug(`Codex AI: Testing connection to ${this.baseUrl}/v1beta/models/${this.model}`);
      const response = await requestUrl({ url, method: 'GET', throw: false });
      const latencyMs = Date.now() - start;

      if (response.status !== 200) {
        const msg = response.json?.error?.message ?? `HTTP ${response.status}`;
        console.error(`Codex AI: Test failed — ${msg}`);
        return { success: false, message: msg, latencyMs };
      }

      const modelName = response.json?.displayName ?? this.model;
      return {
        success: true,
        message: `Connected to ${modelName}`,
        model: modelName,
        latencyMs,
      };
    } catch (err: unknown) {
      console.error('Codex AI: Test connection error', err);
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Connection failed',
        latencyMs: Date.now() - start,
      };
    }
  }

  private buildContents(request: ChatRequest): GeminiContent[] {
    const contents: GeminiContent[] = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') continue;
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
    return contents;
  }
}
