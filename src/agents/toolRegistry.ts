import type { ToolDefinition } from '../core/types';
import { assertAgentActive } from '../core/agentContext';

/** The same bounded schema is advertised to the model and enforced before dispatch. */
function bounded(schema: any, key = ''): any {
  const s = { ...schema };
  if (s.type === 'object') { s.additionalProperties = false; s.properties = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k,v]) => [k, bounded(v,k)])); }
  if (s.type === 'string') { s.maxLength ??= ['symbol','symbols'].includes(key) ? 200 : 4000; s.minLength ??= 1; }
  if (s.type === 'array') { s.maxItems ??= 50; s.items = bounded(s.items ?? {}); }
  if (['number','integer'].includes(s.type)) {
    if (key === 'days') { s.minimum ??= 1; s.maximum ??= 365; }
    if (key === 'limit' || key === 'top') { s.minimum ??= 1; s.maximum ??= 100; }
  }
  return s;
}
function validate(s: any, value: unknown, at = 'input'): void {
  if (s.enum && !s.enum.includes(value)) throw new Error(`${at}: unsupported value`);
  switch (s.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected an object`);
      for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key}: required`);
      for (const [key,v] of Object.entries(value)) {
        if (!Object.hasOwn(s.properties ?? {}, key)) throw new Error(`${at}.${key}: unexpected field`);
        validate(s.properties[key], v, `${at}.${key}`);
      }
      break;
    case 'string':
      if (typeof value !== 'string' || value.trim().length < (s.minLength ?? 0) || value.length > s.maxLength) throw new Error(`${at}: invalid text length`);
      break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (s.type === 'integer' && !Number.isInteger(value)) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity)) throw new Error(`${at}: invalid number`);
      break;
    case 'boolean': if (typeof value !== 'boolean') throw new Error(`${at}: expected a boolean`); break;
    case 'array':
      if (!Array.isArray(value) || value.length > s.maxItems) throw new Error(`${at}: invalid list`);
      value.forEach((v,i) => validate(s.items,v,`${at}[${i}]`)); break;
  }
}
export class ToolRegistry {
  readonly definitions: ToolDefinition[];
  constructor(definitions: ToolDefinition[], private readonly handler: (name: string, input: Record<string, unknown>) => Promise<string>) {
    this.definitions = definitions.map(t => ({ ...t, input_schema: bounded(t.input_schema) }));
    if (new Set(definitions.map(t => t.name)).size !== definitions.length) throw new Error('Duplicate tool name');
  }
  async execute(name: string, input: unknown): Promise<string> {
    const def = this.definitions.find(t => t.name === name);
    if (!def) return JSON.stringify({ ok: false, error: 'Tool is not permitted for this agent: ' + name });
    try {
      assertAgentActive();
      validate(def.input_schema, input);
      return await this.handler(name, input as Record<string, unknown>);
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err?.message ?? String(err) });
    }
  }
}
