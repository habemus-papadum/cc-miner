/**
 * Turning deduped token counts into dollars.
 *
 * Cost is NOT in the transcript (see `fields.ts` TRAPS `no-cost-field`), so
 * every dollar figure this project shows is a *derived estimate* and must be
 * labelled with the price table that produced it — which is why `PricedUnit`
 * carries `pricedAs` and `PriceTable` carries `version`.
 *
 * ## Source: LiteLLM, not `@pydantic/genai-prices`
 *
 * This repo already depends on `@pydantic/genai-prices` in
 * `packages/aiui-claude-channel`, so reuse was the default. It is the wrong
 * table *here* for one structural reason: it models cache writes as a single
 * bucket — one `cache_write_mtok` rate, one `cache_write_tokens` usage field —
 * and Anthropic charges the 1-hour cache tier at 1.6x the 5-minute one. On the
 * baseline corpus 54.8% of cache-creation tokens are 1h-tier, so flat-rating
 * them understates cache-creation cost by 30.4% and total spend by 6.9%. That
 * is a limit of its schema, not its data. See the proposal, §3.
 *
 * LiteLLM's table is a plain JSON map keyed by model id with per-token (not
 * per-million) rates:
 *
 *   input_cost_per_token
 *   output_cost_per_token
 *   cache_creation_input_token_cost             ← 5-minute TTL
 *   cache_creation_input_token_cost_above_1hr   ← 1-hour TTL, ~1.6x
 *   cache_read_input_token_cost
 */

import type { BillableUnit } from "./fields.ts";
import { splitModel, UNPRICED_MODELS } from "./fields.ts";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface ModelPrice {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  cache_read_input_token_cost?: number;
}

export interface PriceTable {
  entries: Record<string, ModelPrice>;
  /** Identifies exactly which table produced a number. Stamped into Parquet. */
  version: string;
  source: "litellm";
}

export interface PricedUnit {
  model: string;
  /** The table key actually used — visible so a wrong match can be spotted. */
  pricedAs: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
}

/**
 * Resolve a Claude Code model id to a table entry.
 *
 * Claude Code ids are bare (`claude-opus-4-8`) and may carry a bracketed
 * context variant (`claude-opus-4-8[1m]`). LiteLLM keys the same model several
 * ways (bare, `anthropic.`, `us.anthropic.`, …); the bare key carries
 * first-party Anthropic API pricing, so try it first. The variant is tried
 * before the base so a 1M-context call is never silently priced as standard.
 */
export function resolveModel(
  table: PriceTable,
  model: string | undefined,
): { key: string; entry: ModelPrice } | undefined {
  if (!model || UNPRICED_MODELS.has(model)) return undefined;
  const { base, variant } = splitModel(model);
  if (!base) return undefined;
  const candidates = variant ? [`${base}[${variant}]`, `${base}-${variant}`, base] : [base];
  for (const c of candidates) {
    const entry = table.entries[c];
    if (entry) return { key: c, entry };
  }
  for (const prefix of ["anthropic/", "anthropic.", "us.anthropic.", "global.anthropic."]) {
    const entry = table.entries[prefix + base];
    if (entry) return { key: prefix + base, entry };
  }
  return undefined;
}

/**
 * Price one billable unit. Returns `undefined` when the model has no entry —
 * callers must surface that rather than silently treating it as $0.
 */
export function priceUnit(table: PriceTable, u: BillableUnit): PricedUnit | undefined {
  const hit = resolveModel(table, u.model);
  if (!hit || !u.model) return undefined;
  const e = hit.entry;
  const rate5m = e.cache_creation_input_token_cost ?? 0;
  const rate1h = e.cache_creation_input_token_cost_above_1hr ?? rate5m;
  // Prefer the explicit TTL split; fall back to the aggregate when a build
  // predates `cache_creation.*`.
  const cacheCreate =
    u.cache5m + u.cache1h > 0 ? u.cache5m * rate5m + u.cache1h * rate1h : u.cacheCreate * rate5m;
  const input = u.input * (e.input_cost_per_token ?? 0);
  const output = u.output * (e.output_cost_per_token ?? 0);
  const cacheRead = u.cacheRead * (e.cache_read_input_token_cost ?? 0);
  return {
    model: u.model,
    pricedAs: hit.key,
    input,
    output,
    cacheCreate,
    cacheRead,
    total: input + output + cacheCreate + cacheRead,
  };
}

/** Build a table from an already-parsed LiteLLM JSON blob. */
export function tableFromJson(json: unknown, version: string): PriceTable {
  const entries: Record<string, ModelPrice> = {};
  if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (v && typeof v === "object") entries[k] = v as ModelPrice;
    }
  }
  return { entries, version, source: "litellm" };
}
