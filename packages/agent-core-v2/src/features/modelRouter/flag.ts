import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MODEL_ROUTER_FLAG_ID = 'model_router';
export const MODEL_ROUTER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MODEL_ROUTER';

export const modelRouterFlag: FlagDefinitionInput = {
  id: MODEL_ROUTER_FLAG_ID,
  title: 'Adaptive model router',
  description:
    'Classify each user task by difficulty (T0-T3) and switch the main agent to the configured tier model before the turn starts. Includes bounded failure escalation and subagent model selection.',
  env: MODEL_ROUTER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(modelRouterFlag);
