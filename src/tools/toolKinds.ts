/**
 * What each tool does, in five kinds:
 *
 *   read          looks something up; a successful result is evidence
 *   act           changes the account: queues an order action or saves the strategy
 *   record        saves a judgement (a review, an assessment, a lesson)
 *   handoff       gives work to another agent as a new request
 *   housekeeping  answers an event or ends the cycle
 *
 * Kinds live here rather than on the definitions because definitions are sent to the model
 * provider as they are, and it refuses fields it does not know.
 */
export type ToolKind = 'read' | 'act' | 'record' | 'handoff' | 'housekeeping';

const KINDS: Record<Exclude<ToolKind, 'read'>, string[]> = {
  act: ['execute_entry', 'execute_exit', 'annotate_position', 'update_trading_settings'],
  record: ['record_position_review', 'record_candidate_review', 'record_research_review', 'write_lesson'],
  handoff: ['request_research', 'send_to_trader'],
  housekeeping: ['ack_event', 'sleep'],
};
/** Reads not named get_… */
const OTHER_READS = ['read_source', 'read_app', 'compare_position_actions', 'web_search', 'show_price_history', 'show_performance_comparison'];

/** The kind of a tool, or null for a name no agent has. Every `get_…` tool is a read. */
export function toolKind(name: string): ToolKind | null {
  for (const [kind, names] of Object.entries(KINDS)) if (names.includes(name)) return kind as ToolKind;
  return name.startsWith('get_') || OTHER_READS.includes(name) ? 'read' : null;
}
