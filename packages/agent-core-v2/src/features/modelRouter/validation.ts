import { Error2, ErrorCodes } from '#/errors';
import type { IConfigService } from '#/app/config/config';
import type { IModelCatalog } from '#/llm-adapter/model/catalog';

import { MODEL_ROUTER_SECTION, ROUTER_TIER_IDS, type ModelRouterConfigData } from './configSection';

export function assertValidModelRouterConfig(
  config: IConfigService,
  modelCatalog: IModelCatalog,
  active: boolean,
): void {
  const section = config.get<ModelRouterConfigData | undefined>(MODEL_ROUTER_SECTION);
  if (!active || section?.enabled !== true) return;
  const tiers = section.tiers ?? {};
  for (const tier of ROUTER_TIER_IDS) {
    const model = tiers[tier]?.model;
    if (model === undefined) continue;
    try {
      modelCatalog.get(model);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[model_router.tiers.${tier}].model "${model}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { section: MODEL_ROUTER_SECTION, tier, model } },
      );
    }
  }
}
