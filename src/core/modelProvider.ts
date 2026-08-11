import Anthropic from '@anthropic-ai/sdk';
import { AiConfig, ChatMessage, ContentBlock, ModelResponse, ToolDefinition } from './types';

// ── Provider interface ────────────────────────────────────────────────────────

export interface ModelProvider {
  chat(params: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<ModelResponse>;
}

// ── Anthropic implementation ──────────────────────────────────────────────────

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  private model: string;

  constructor(cfg: AiConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    });
    this.model = cfg.model;
  }

  async chat(params: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    const { systemPrompt, messages, tools, maxTokens } = params;

    // Translate internal ChatMessage[] to Anthropic message format
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content.map((block): Anthropic.ContentBlockParam => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        // tool_result
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        };
      }),
    }));

    const response = await this.client.messages.create({
      model: this.model,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: tools as Anthropic.Tool[],
      max_tokens: maxTokens,
    });

    // Translate response back to internal format (skip thinking/redacted blocks)
    const content: ContentBlock[] = response.content.flatMap((block): ContentBlock[] => {
      if (block.type === 'text') {
        return [{ type: 'text', text: block.text }];
      }
      if (block.type === 'tool_use') {
        return [{
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        }];
      }
      // Skip thinking, redacted_thinking, and other extended block types
      return [];
    });

    return {
      stopReason: response.stop_reason as ModelResponse['stopReason'],
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createModelProvider(cfg: AiConfig): ModelProvider {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicProvider(cfg);
    default:
      throw new Error(`Unknown AI provider: "${cfg.provider}". Supported: anthropic`);
  }
}
