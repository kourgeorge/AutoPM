export interface Bar {
  t: string;   // timestamp ISO
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
}


export interface SignalResult {
  symbol: string;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  price: number;
  atr: number;
  stopLoss: number;
  takeProfit: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ModelResponse {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  content: ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;           // LiteLLM or any custom endpoint; undefined = use provider default
  maxTokensPerTurn: number;
  maxToolRounds: number;
}


