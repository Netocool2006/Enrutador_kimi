import type { ProfileModelChangeSource } from '#/agent/profile/profile';

import {
  classifyTask,
  nextTier,
  ROUTER_TIER_ORDER,
  type ClassifierOptions,
  type Classification,
  type RouterTier,
} from './classifier';

export type { ProfileModelChangeSource };

export interface RouterTierEntry {
  readonly model?: string;
  readonly effort?: string;
}

export interface ModelRouterSubagentConfig {
  readonly enabled?: boolean;
}

export interface ModelRouterConfig {
  readonly enabled?: boolean;
  readonly simulation?: boolean;
  readonly respectUserChoice?: boolean;
  readonly maxEscalationsPerTurn?: number;
  readonly roundUpWhenUncertain?: boolean;
  readonly riskKeywords?: readonly string[];
  readonly subagents?: ModelRouterSubagentConfig;
  readonly tiers?: Partial<Record<RouterTier, RouterTierEntry>>;
}

export const DEFAULT_MAX_ESCALATIONS_PER_TURN = 1;

export interface TurnRoutingInput {
  readonly text: string;
  readonly currentModel: string;
  readonly modelSource: ProfileModelChangeSource;
  readonly config: ModelRouterConfig;
  readonly hasModel: (alias: string) => boolean;
}

export type TurnRoutingDecision =
  | {
      readonly kind: 'switch';
      readonly classification: Classification;
      readonly model: string;
      readonly effort?: string;
    }
  | { readonly kind: 'simulate'; readonly classification: Classification; readonly model: string; readonly effort?: string }
  | { readonly kind: 'keep'; readonly classification: Classification; readonly reason: string }
  | { readonly kind: 'error'; readonly classification: Classification; readonly message: string };

export function routerActive(config: ModelRouterConfig): boolean {
  return config.enabled === true;
}

export function classifyForRouter(
  text: string,
  config: ModelRouterConfig,
): Classification {
  const options: ClassifierOptions = {
    riskKeywords: config.riskKeywords,
    roundUpWhenUncertain: config.roundUpWhenUncertain,
  };
  return classifyTask(text, options);
}

function tierEntry(
  config: ModelRouterConfig,
  tier: RouterTier,
): RouterTierEntry | undefined {
  return config.tiers?.[tier];
}

export function planTurnRouting(input: TurnRoutingInput): TurnRoutingDecision {
  const classification = classifyForRouter(input.text, input.config);
  const entry = tierEntry(input.config, classification.tier);
  if (entry?.model === undefined) {
    return { kind: 'keep', classification, reason: 'no-model-configured-for-tier' };
  }
  if (!input.hasModel(entry.model)) {
    return {
      kind: 'error',
      classification,
      message: `model_router: tier ${classification.tier} names unknown model alias "${entry.model}". Add it under [models] or fix [model_router.tiers.${classification.tier}].model.`,
    };
  }
  if (entry.model === input.currentModel) {
    return { kind: 'keep', classification, reason: 'already-on-model' };
  }
  if (input.modelSource === 'user' && input.config.respectUserChoice !== false) {
    return { kind: 'keep', classification, reason: 'user-model-choice' };
  }
  if (input.config.simulation === true) {
    return {
      kind: 'simulate',
      classification,
      model: entry.model,
      effort: entry.effort,
    };
  }
  return { kind: 'switch', classification, model: entry.model, effort: entry.effort };
}

export interface EscalationInput {
  readonly currentTier: RouterTier;
  readonly escalationsUsed: number;
  readonly config: ModelRouterConfig;
  readonly hasModel: (alias: string) => boolean;
}

export interface EscalationPlan {
  readonly tier: RouterTier;
  readonly model: string;
  readonly effort?: string;
}

export function planEscalation(input: EscalationInput): EscalationPlan | undefined {
  const max = input.config.maxEscalationsPerTurn ?? DEFAULT_MAX_ESCALATIONS_PER_TURN;
  if (input.escalationsUsed >= max) return undefined;
  let tier = input.currentTier;
  while (tier !== 'T3') {
    const next = nextTier(tier);
    if (next === undefined) return undefined;
    tier = next;
    const entry = tierEntry(input.config, tier);
    if (entry?.model === undefined) continue;
    if (!input.hasModel(entry.model)) continue;
    return { tier, model: entry.model, effort: entry.effort };
  }
  return undefined;
}

export interface SubagentRoutingInput {
  readonly text: string;
  readonly explicitModel: string | undefined;
  readonly pool: Record<string, string> | undefined;
  readonly poolDefault: string | undefined;
  readonly config: ModelRouterConfig;
  readonly hasModel: (alias: string) => boolean;
}

export interface SubagentRoutingDecision {
  readonly model: string | undefined;
  readonly classification?: Classification;
  readonly reason: string;
}

export function planSubagentRouting(input: SubagentRoutingInput): SubagentRoutingDecision {
  if (input.explicitModel !== undefined) {
    return { model: input.explicitModel, reason: 'explicit-model' };
  }
  if (input.config.subagents?.enabled !== true) {
    return { model: undefined, reason: 'router-subagents-disabled' };
  }
  if (input.pool === undefined) {
    return { model: undefined, reason: 'no-subagent-pool' };
  }
  const classification = classifyForRouter(input.text, input.config);
  const entry = tierEntry(input.config, classification.tier);
  if (entry?.model !== undefined && Object.hasOwn(input.pool, entry.model)) {
    return { model: entry.model, classification, reason: 'tier-model' };
  }
  if (input.poolDefault !== undefined && Object.hasOwn(input.pool, input.poolDefault)) {
    return { model: input.poolDefault, classification, reason: 'pool-default' };
  }
  return { model: undefined, classification, reason: 'pool-default-unavailable' };
}

export function highestTier(a: RouterTier, b: RouterTier): RouterTier {
  return ROUTER_TIER_ORDER[a] >= ROUTER_TIER_ORDER[b] ? a : b;
}
