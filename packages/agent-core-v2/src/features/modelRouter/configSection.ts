import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

import type { RouterTier } from './classifier';

export const MODEL_ROUTER_SECTION = 'modelRouter';

export const RouterTierEntrySchema = z
  .object({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  })
  .strict();

export const ModelRouterConfigSchema = z.object({
  enabled: z.boolean().optional(),
  simulation: z.boolean().optional(),
  respectUserChoice: z.boolean().optional(),
  maxEscalationsPerTurn: z.number().int().min(0).max(5).optional(),
  roundUpWhenUncertain: z.boolean().optional(),
  logMaxBytes: z.number().int().min(1).optional(),
  riskKeywords: z.array(z.string().min(1)).optional(),
  subagents: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  tiers: z
    .object({
      T0: RouterTierEntrySchema.optional(),
      T1: RouterTierEntrySchema.optional(),
      T2: RouterTierEntrySchema.optional(),
      T3: RouterTierEntrySchema.optional(),
    })
    .strict()
    .optional(),
});

export type ModelRouterConfigData = z.infer<typeof ModelRouterConfigSchema>;

registerConfigSection(MODEL_ROUTER_SECTION, ModelRouterConfigSchema);

export const ROUTER_TIER_IDS: readonly RouterTier[] = ['T0', 'T1', 'T2', 'T3'];
