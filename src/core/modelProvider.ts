import Anthropic from '@anthropic-ai/sdk';
import { AiConfig, ChatMessage, ContentBlock, ModelResponse, ToolDefinition } from './types';

// ── Provider interface ────────────────────────────────────────────────────────

export interface ModelProvider {
  chat(params: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    /** Forces the model to answer via this exact tool instead of free-form text. Optional — omit for today's behavior. */
    toolChoice?: { type: 'tool'; name: string };
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
    toolChoice?: { type: 'tool'; name: string };
  }): Promise<ModelResponse> {
    const { systemPrompt, messages, tools, maxTokens, toolChoice } = params;

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
      ...(toolChoice ? { tool_choice: { type: 'tool' as const, name: toolChoice.name } } : {}),
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

// ── OpenAI-compatible provider (for OpenAI, Azure, Groq, Ollama, LiteLLM, etc.) ──

/**
 * Known OpenAI-compatible endpoints. A provider NOT in here needs an explicit
 * `AI_BASE_URL` — the URL is never guessed from the provider name, because guessing sends
 * `Authorization: Bearer <the operator's key>` to whatever domain the guess happens to
 * spell. `api.<typo>.com` is registrable by anyone.
 */
const KNOWN_BASE_URLS: Record<string, string> = {
  openai:   'https://api.openai.com/v1',
  groq:     'https://api.groq.com/openai/v1',
  ollama:   'http://localhost:11434/v1',
  cohere:   'https://api.cohere.ai/v1',
  together: 'https://api.together.xyz/v1',
};

export class OpenAICompatibleProvider implements ModelProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(cfg: AiConfig) {
    const known = KNOWN_BASE_URLS[cfg.provider.toLowerCase()];
    if (!cfg.baseUrl && !known) {
      throw new Error(
        `Unknown AI provider "${cfg.provider}" and no AI_BASE_URL set. Either set AI_BASE_URL ` +
        `to the endpoint explicitly, or use one of: anthropic, ${Object.keys(KNOWN_BASE_URLS).join(', ')}.`,
      );
    }
    this.baseUrl = (cfg.baseUrl ?? known!).replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
  }

  async chat(params: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    toolChoice?: { type: 'tool'; name: string };
  }): Promise<ModelResponse> {
    const { systemPrompt, messages, tools, maxTokens, toolChoice } = params;

    // Translate internal ChatMessage[] (Anthropic-shaped) to OpenAI chat messages.
    //
    // The two formats disagree about where a tool call lives, and the disagreement is the
    // whole difficulty here. Anthropic carries calls and results as content BLOCKS inside
    // the assistant and user turns; OpenAI carries calls in a `tool_calls` field that is a
    // SIBLING of `content` (whose parts are text only), and results as their own `tool`
    // messages keyed by `tool_call_id`. Putting a call inside `content` is rejected, and a
    // `tool` message without its id has nothing to answer — so the ids that Anthropic keeps
    // on the blocks (`tool_use.id`, `tool_result.tool_use_id`) must be carried across, not
    // dropped.
    //
    // Content is sent as a plain string rather than a parts array: every OpenAI-compatible
    // endpoint accepts the string form, and the smaller ones do not all accept parts.
    interface OpenAIToolCall {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }
    interface OpenAIMessage {
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      tool_call_id?: string;
    }

    const openaiMessages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];

    for (const msg of messages) {
      const text = msg.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      if (msg.role === 'user') {
        // Results first: they answer the calls made by the assistant turn just pushed, and
        // OpenAI requires each `tool` message to follow the assistant message that made it.
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
        if (text.length > 0) openaiMessages.push({ role: 'user', content: text });
        continue;
      }

      const toolCalls: OpenAIToolCall[] = msg.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map(b => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));

      // `content: null` with tool_calls present is the documented shape for a turn that
      // only calls tools. Skipping the message entirely would orphan the results below it.
      if (text.length > 0 || toolCalls.length > 0) {
        openaiMessages.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    }

    // Convert tool definitions to OpenAI format (they already match JSON Schema)
    const openaiTools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    // OpenAI's legacy models accept `max_tokens`; everything newer (o-series, gpt-4.1+,
    // gpt-4.5+, gpt-5+, …) requires `max_completion_tokens`. Third-party OpenAI-compatible
    // endpoints (Groq, Ollama, Together, LiteLLM, etc.) use `max_tokens`.
    // Strategy: use `max_completion_tokens` for models that are known to require it
    // (o-series and any gpt-N where N >= 4.1), and `max_tokens` for everything else.
    // This is checked against the base URL so that a LiteLLM proxy forwarding to openai
    // with model="gpt-5-nano" still sends the right param.
    const isOpenAIEndpoint = this.baseUrl.includes('api.openai.com');
    const isNewOpenAIModel = /^o\d|^gpt-(?!3\.5|4$|4-)(4\.[1-9]|[5-9])/.test(this.model);
    const usesCompletionTokens = isOpenAIEndpoint && isNewOpenAIModel;
    const tokenParam = usesCompletionTokens
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };

    // The gpt-5+ models reason by DEFAULT, and on /v1/chat/completions reasoning and function
    // tools are mutually exclusive:
    //
    //   "Function tools with reasoning_effort are not supported for gpt-5.6-luna in
    //    /v1/chat/completions. To use function tools, use /v1/responses or set
    //    reasoning_effort to 'none'."
    //
    // Note what that means: SENDING NOTHING IS NOT NEUTRAL. Omitting the field leaves the
    // model's own default effort in force, so the rejection arrives for a parameter this code
    // never set. The only way to decline reasoning is to say `none` explicitly.
    //
    // Scoped to gpt-N because the o-series does not accept `none` at all — reasoning is not
    // optional there, and o-series + tools on chat/completions is already accepted as-is.
    // Scoped to a non-empty tool list because a tool-free call (the concierge's plain answers)
    // is not in conflict, and should keep whatever thinking the model would do unbidden.
    // Matched against the model name with any LiteLLM routing prefix ("azure/", "openai/", …)
    // stripped, and independent of which host serves it — a proxy forwards this model-level
    // constraint through rather than normalizing it away. Confirmed: "azure/gpt-5.6-luna" via a
    // LiteLLM proxy (not api.openai.com) 400'd on a plain `temperature: 0` override too — see
    // the temperature line below.
    const bareModel = this.model.replace(/^[^/]+\//, '');
    const isGptReasoningModel = /^gpt-[5-9]/.test(bareModel);
    const isReasoningModel = isGptReasoningModel || /^o\d/.test(bareModel);
    const reasoningParam = isGptReasoningModel && openaiTools.length > 0
      ? { reasoning_effort: 'none' }
      : {};

    // Make the API request
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: openaiMessages,
        tools: openaiTools,
        ...(toolChoice ? { tool_choice: { type: 'function', function: { name: toolChoice.name } } } : {}),
        ...tokenParam,
        ...reasoningParam,
        // o-series and gpt-5+ models don't accept a temperature override — omit it
        // entirely for those so the API uses its default. Legacy models get 0 for
        // deterministic output.
        ...(usesCompletionTokens ? {} : { temperature: 0 }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = await response.json() as any;

    const choice = data?.choices?.[0];
    if (!choice) {
      throw new Error(`OpenAI API returned no choices: ${JSON.stringify(data).slice(0, 400)}`);
    }

    // Convert response back to internal format
    const content: ContentBlock[] = [];

    if (choice.message?.content) {
      content.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    for (const toolCall of choice.message?.tool_calls ?? []) {
      if (toolCall.type !== 'function') continue;
      // A malformed `arguments` string is the model's error, not a transport failure. It
      // must not take down the cycle: surface it as the tool's own input so the executor
      // rejects it and the model sees why, which is what happens on the Anthropic path when
      // a tool is called with the wrong shape.
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        input = { __unparseable_arguments: toolCall.function.arguments };
      }
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      });
    }

    return {
      // Some endpoints (Ollama especially) omit `usage`. Reporting 0 is honest — it is what
      // was reported — and beats crashing a cycle over a telemetry field.
      stopReason: this.mapStopReason(choice.finish_reason),
      content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  private mapStopReason(finishReason: string): ModelResponse['stopReason'] {
    switch (finishReason) {
      case 'tool_calls':
      case 'function_call':
        return 'tool_use';
      // OpenAI's 'stop' is a natural finish, which is Anthropic's 'end_turn'.
      // 'stop_sequence' would claim a custom stop sequence was hit; we send none.
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * `anthropic` uses the SDK; everything else speaks the OpenAI chat-completions dialect.
 *
 * An unrecognised provider is accepted ONLY with an explicit `AI_BASE_URL` — that is what
 * makes a LiteLLM proxy or a self-hosted endpoint work without a case here. Without one the
 * constructor throws, because the alternative is inventing a URL for a name that may simply
 * be a typo and posting the API key to it.
 */
export function createModelProvider(cfg: AiConfig): ModelProvider {
  if (cfg.provider.toLowerCase() === 'anthropic') return new AnthropicProvider(cfg);
  return new OpenAICompatibleProvider(cfg);
}
