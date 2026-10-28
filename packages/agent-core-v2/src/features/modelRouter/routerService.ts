import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService, type LoopErrorContext, type PromptSubmitContext } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentModelForced,
  resolveSubagentModelPool,
} from '#/session/subagent/configSection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import type { RouterTier } from './classifier';
import { MODEL_ROUTER_SECTION, type ModelRouterConfigData } from './configSection';
import { MODEL_ROUTER_FLAG_ID } from './flag';
import {
  DEFAULT_ROUTER_LOG_MAX_BYTES,
  resolveRouterLogPath,
  RouterLog,
  type RouterLogRecord,
} from './log';
import {
  planEscalation,
  planSubagentRouting,
  planTurnRouting,
  routerActive,
} from './policy';

export interface IAgentModelRouterService {
  readonly _serviceBrand: undefined;

  routeSubagent(taskText: string, explicitModel: string | undefined): string | undefined;

  flushLog(): Promise<unknown>;
}

export const IAgentModelRouterService =
  createDecorator<IAgentModelRouterService>('agentModelRouterService');

export class AgentModelRouterService extends Service implements IAgentModelRouterService {
  declare readonly _serviceBrand: undefined;

  private readonly routerLog: RouterLog;
  private currentTier: RouterTier | undefined;
  private escalationsUsed = 0;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ILogService private readonly engineLog: ILogService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    const config = this.routerConfig();
    this.routerLog = new RouterLog(
      resolveRouterLogPath(this.sessionContext.sessionDir),
      config.logMaxBytes ?? DEFAULT_ROUTER_LOG_MAX_BYTES,
    );
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    const loop = instantiation.invokeFunction((accessor) => accessor.get(IAgentLoopService));
    this.registerPromptHook(loop);
    this.registerEscalationHandler(loop);
  }

  routeSubagent(taskText: string, explicitModel: string | undefined): string | undefined {
    const config = this.routerConfig();
    const forced = isSubagentModelForced(this.configService);
    const pool = forced ? undefined : resolveSubagentModelPool(this.configService);
    const enabledConfig: ModelRouterConfigData =
      this.flags.enabled(MODEL_ROUTER_FLAG_ID) && routerActive(config)
        ? config
        : { subagents: { enabled: false } };
    const decision = planSubagentRouting({
      text: taskText,
      explicitModel,
      pool: pool?.models,
      poolDefault: pool?.defaultModel,
      config: enabledConfig,
      hasModel: (alias) => this.hasModel(alias),
    });
    if (decision.reason === 'tier-model' || decision.reason === 'pool-default') {
      this.writeLog({
        kind: 'subagent',
        action: 'route',
        tier: decision.classification?.tier,
        model: decision.model,
        reasons: decision.classification?.reasons,
      });
    }
    return decision.model;
  }

  flushLog(): Promise<unknown> {
    return this.routerLog.flush();
  }

  override dispose(): void {
    void this.routerLog.flush();
    super.dispose();
  }

  private registerPromptHook(loop: IAgentLoopService): void {
    this._register(
      loop.hooks.onBeforeSubmitPrompt.register('modelRouter', async (ctx, next) => {
        await this.routeTurnPrompt(ctx);
        await next();
      }),
    );
  }

  private registerEscalationHandler(loop: IAgentLoopService): void {
    this._register(
      loop.registerLoopErrorHandler({
        id: 'modelRouter',
        match: (context) => this.canEscalate(context),
        handle: (context) => this.escalate(context),
      }),
    );
  }

  private async routeTurnPrompt(ctx: PromptSubmitContext): Promise<void> {
    if (ctx.isSteer) return;
    if ((ctx.promptMessage.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    const config = this.routerConfig();
    if (!this.flags.enabled(MODEL_ROUTER_FLAG_ID) || !routerActive(config)) return;
    const text = promptText(ctx.promptMessage);
    if (text.trim() === '') return;
    const previousModel = this.profile.getModel();
    const decision = planTurnRouting({
      text,
      currentModel: previousModel,
      modelSource: this.profile.getModelChangeSource(),
      config,
      hasModel: (alias) => this.hasModel(alias),
    });
    this.currentTier = decision.classification.tier;
    this.escalationsUsed = 0;
    switch (decision.kind) {
      case 'switch':
        await this.applyModel(decision.model, decision.effort);
        this.writeLog({
          kind: 'turn',
          action: 'switch',
          tier: decision.classification.tier,
          model: decision.model,
          previousModel,
          effort: decision.effort,
          reasons: decision.classification.reasons,
        });
        break;
      case 'simulate':
        this.writeLog({
          kind: 'turn',
          action: 'simulate-switch',
          tier: decision.classification.tier,
          model: decision.model,
          previousModel,
          effort: decision.effort,
          reasons: decision.classification.reasons,
          simulated: true,
        });
        break;
      case 'keep':
        this.writeLog({
          kind: 'turn',
          action: 'keep',
          tier: decision.classification.tier,
          model: previousModel,
          reasons: [...decision.classification.reasons, `keep:${decision.reason}`],
        });
        break;
      case 'error':
        this.writeLog({
          kind: 'turn',
          action: 'error',
          tier: decision.classification.tier,
          model: previousModel,
          reasons: decision.classification.reasons,
          detail: decision.message,
        });
        this.engineLog.warn(decision.message);
        break;
    }
  }

  private canEscalate(context: LoopErrorContext): boolean {
    if (context.signal.aborted) return false;
    const config = this.routerConfig();
    if (!this.flags.enabled(MODEL_ROUTER_FLAG_ID) || !routerActive(config)) return false;
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return false;
    if (this.profile.getModelChangeSource() === 'user') return false;
    const tier = this.currentTier;
    if (tier === undefined) return false;
    return (
      planEscalation({
        currentTier: tier,
        escalationsUsed: this.escalationsUsed,
        config,
        hasModel: (alias) => this.hasModel(alias),
      }) !== undefined
    );
  }

  private async escalate(context: LoopErrorContext): Promise<boolean> {
    if (!this.canEscalate(context)) return false;
    const config = this.routerConfig();
    const tier = this.currentTier;
    if (tier === undefined) return false;
    const plan = planEscalation({
      currentTier: tier,
      escalationsUsed: this.escalationsUsed,
      config,
      hasModel: (alias) => this.hasModel(alias),
    });
    if (plan === undefined) return false;
    const previousModel = this.profile.getModel();
    try {
      await this.applyModel(plan.model, plan.effort);
    } catch (error) {
      this.engineLog.warn('model_router: escalation switch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.escalationsUsed += 1;
    this.currentTier = plan.tier;
    this.llmRequester.invalidateTurnConfig(context.turnId);
    this.writeLog({
      kind: 'escalation',
      action: 'escalate',
      tier: plan.tier,
      model: plan.model,
      previousModel,
      effort: plan.effort,
    });
    context.retry();
    return true;
  }

  private async applyModel(model: string, effort: string | undefined): Promise<void> {
    await this.profile.setModel(model, 'router');
    if (effort === undefined) return;
    try {
      this.profile.setThinking(effort);
    } catch (error) {
      this.engineLog.warn('model_router: failed to apply thinking effort', {
        model,
        effort,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private routerConfig(): ModelRouterConfigData {
    return this.configService.get<ModelRouterConfigData | undefined>(MODEL_ROUTER_SECTION) ?? {};
  }

  private hasModel(alias: string): boolean {
    try {
      this.modelCatalog.get(alias);
      return true;
    } catch {
      return false;
    }
  }

  private writeLog(record: Omit<RouterLogRecord, 'ts' | 'sessionId'>): void {
    this.routerLog.record({
      ts: new Date().toISOString(),
      sessionId: this.sessionContext.sessionId,
      ...record,
    });
  }
}

function promptText(message: ContextMessage): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}
