import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { MODEL_ROUTER_SECTION, ModelRouterConfigSchema } from './configSection';
import {
  ISessionModelRouterValidationService,
  SessionModelRouterValidationService,
} from './validationService';
import { IAgentModelRouterService, AgentModelRouterService } from './routerService';

export class ModelRouterFeature extends Feature {
  static override readonly name = 'modelRouter';

  constructor() {
    super();
    this.contributeConfig(MODEL_ROUTER_SECTION, ModelRouterConfigSchema);
    this.contributeAgentService(IAgentModelRouterService, AgentModelRouterService);
    this.contributeService(
      LifecycleScope.Session,
      ISessionModelRouterValidationService,
      SessionModelRouterValidationService,
      { activation: ScopeActivation.OnScopeCreated },
    );
  }
}

registerFeature(ModelRouterFeature);
