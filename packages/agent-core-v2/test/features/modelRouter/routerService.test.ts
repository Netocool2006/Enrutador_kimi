import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toDisposable } from '#/_base/di/lifecycle';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { LoopErrorContext, PromptSubmitContext } from '#/agent/loop/loop';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IModelCatalog } from '#/llm-adapter/model/catalog';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AgentModelRouterService } from '#/features/modelRouter/routerService';
import type { ModelRouterConfigData } from '#/features/modelRouter/configSection';
import { ROUTER_LOG_FILE } from '#/features/modelRouter/log';
import { stubFlag } from '../../app/flag/stubs';
import { stubConfigService } from '../../app/config/stubs';
import { stubLog } from '../../_base/log/stubs';

const KNOWN_MODELS = new Set(['provider/fast', 'provider/smart', 'provider/max']);
const TIERS = {
  T0: { model: 'provider/fast' },
  T1: { model: 'provider/fast' },
  T2: { model: 'provider/smart' },
  T3: { model: 'provider/max' },
};

interface Harness {
  service: AgentModelRouterService;
  setModel: ReturnType<typeof vi.fn>;
  setThinking: ReturnType<typeof vi.fn>;
  getModelChangeSource: ReturnType<typeof vi.fn>;
  invalidateTurnConfig: ReturnType<typeof vi.fn>;
  submitPromptHook: (ctx: PromptSubmitContext, next?: () => Promise<void>) => Promise<void>;
  errorHandler: {
    match: (context: LoopErrorContext) => boolean;
    handle: (context: LoopErrorContext) => Promise<boolean | undefined>;
  };
  retry: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  dir: string;
}

async function createHarness(options?: {
  agentId?: string;
  flagEnabled?: boolean;
  routerConfig?: ModelRouterConfigData;
  currentModel?: string;
  modelSource?: 'startup' | 'user' | 'router';
  secondaryModel?: Record<string, unknown>;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'model-router-test-'));
  const setModel = vi.fn(async () => ({ model: 'x' }));
  const setThinking = vi.fn();
  const getModelChangeSource = vi.fn(() => options?.modelSource ?? 'startup');
  const invalidateTurnConfig = vi.fn();
  const retry = vi.fn();
  const warn = vi.fn();

  const profile = {
    _serviceBrand: undefined,
    getModel: () => options?.currentModel ?? 'provider/max',
    setModel,
    setThinking,
    getModelChangeSource,
  } as unknown as IAgentProfileService;

  const modelCatalog = {
    _serviceBrand: undefined,
    get: (alias: string) => {
      if (!KNOWN_MODELS.has(alias)) throw new Error(`unknown model ${alias}`);
      return { alias };
    },
  } as unknown as IModelCatalog;

  const llmRequester = {
    _serviceBrand: undefined,
    invalidateTurnConfig,
  } as unknown as IAgentLLMRequesterService;

  const sessionContext = {
    sessionId: 'session-test',
    sessionDir: dir,
    cwd: dir,
  } as unknown as ISessionContext;

  let submitPromptHook: Harness['submitPromptHook'] = async () => {};
  const errorHandlerRef: { current?: Harness['errorHandler'] } = {};
  const loopStub = {
    hooks: {
      onBeforeSubmitPrompt: {
        register: (
          _id: string,
          handler: (ctx: PromptSubmitContext, next: () => Promise<void>) => Promise<void>,
        ) => {
          submitPromptHook = async (ctx: PromptSubmitContext, next?: () => Promise<void>) => {
            await handler(ctx, next ?? (async () => {}));
          };
          return toDisposable(() => {});
        },
      },
    },
    registerLoopErrorHandler: (handler: Harness['errorHandler']) => {
      errorHandlerRef.current = handler;
      return toDisposable(() => {});
    },
  };
  const instantiation = {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: () => loopStub }),
  };

  const configService = stubConfigService({
    modelRouter: options?.routerConfig ?? { enabled: true, tiers: TIERS },
    secondaryModel: options?.secondaryModel,
  });

  const service = new AgentModelRouterService(
    configService,
    stubFlag(options?.flagEnabled ?? true),
    modelCatalog,
    profile,
    llmRequester,
    makeAgentScopeContext({
      agentId: options?.agentId ?? 'main',
      agentScope: options?.agentId ?? 'main',
    }),
    sessionContext,
    { ...stubLog(), warn } as never,
    instantiation as never,
  );

  return {
    service,
    setModel,
    setThinking,
    getModelChangeSource,
    invalidateTurnConfig,
    submitPromptHook,
    errorHandler: errorHandlerRef.current!,
    retry,
    warn,
    dir,
  };
}

function promptCtx(text: string): { ctx: PromptSubmitContext; next: () => Promise<void> } {
  const ctx = {
    promptMessage: {
      origin: { kind: 'user' },
      content: [{ type: 'text', text }],
    } as unknown as ContextMessage,
    isSteer: false,
    hookParts: [],
    block: false,
  };
  return { ctx: ctx as PromptSubmitContext, next: vi.fn(async () => {}) };
}

function errorCtx(turnId: number): LoopErrorContext {
  return {
    turnId,
    signal: new AbortController().signal,
    error: new Error('request failed'),
    retry: vi.fn(),
  };
}

async function readLog(h: Harness): Promise<Record<string, unknown>[]> {
  await h.service.flushLog();
  const raw = await readFile(join(h.dir, ROUTER_LOG_FILE), 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('AgentModelRouterService', () => {
  const dirs: string[] = [];

  async function harness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
    const h = await createHarness(options);
    dirs.push(h.dir);
    return h;
  }

  beforeEach(() => {
    dirs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('does not register hooks for non-main agents', async () => {
    let registered = false;
    const dir = await mkdtemp(join(tmpdir(), 'model-router-test-'));
    dirs.push(dir);
    const service = new AgentModelRouterService(
      stubConfigService({}),
      stubFlag(true),
      { get: () => ({}) } as unknown as IModelCatalog,
      {} as unknown as IAgentProfileService,
      {} as unknown as IAgentLLMRequesterService,
      makeAgentScopeContext({ agentId: 'agent-sub-1', agentScope: 'agent-sub-1' }),
      { sessionId: 's', sessionDir: dir, cwd: dir } as unknown as ISessionContext,
      stubLog(),
      {
        invokeFunction: () => {
          registered = true;
        },
      } as never,
    );
    expect(registered).toBe(false);
    expect(service).toBeDefined();
  });

  it('switches the main agent model before the turn for a trivial task', async () => {
    const h = await harness({ currentModel: 'provider/max' });
    const { ctx, next } = promptCtx('Find the file where the router config is loaded');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).toHaveBeenCalledWith('provider/fast', 'router');
    expect(next).toHaveBeenCalled();
    const log = await readLog(h);
    expect(log.at(-1)).toMatchObject({
      kind: 'turn',
      action: 'switch',
      tier: 'T0',
      model: 'provider/fast',
      previousModel: 'provider/max',
    });
  });

  it('switches to the complex tier model for a complex task and applies the configured effort', async () => {
    const h = await harness({
      currentModel: 'provider/fast',
      routerConfig: {
        enabled: true,
        tiers: { ...TIERS, T2: { model: 'provider/smart', effort: 'high' } },
      },
    });
    const { ctx, next } = promptCtx('Debug the race condition in the connection pool');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).toHaveBeenCalledWith('provider/smart', 'router');
    expect(h.setThinking).toHaveBeenCalledWith('high');
  });

  it('never switches models in simulation mode but records the decision', async () => {
    const h = await harness({
      currentModel: 'provider/max',
      routerConfig: { enabled: true, simulation: true, tiers: TIERS },
    });
    const { ctx, next } = promptCtx('Fix a typo in the readme');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.setThinking).not.toHaveBeenCalled();
    const log = await readLog(h);
    expect(log.at(-1)).toMatchObject({ action: 'simulate-switch', model: 'provider/fast', simulated: true });
  });

  it('respects an explicit user model choice and does not switch', async () => {
    const h = await harness({ currentModel: 'provider/max', modelSource: 'user' });
    const { ctx, next } = promptCtx('Fix a typo in the readme');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).not.toHaveBeenCalled();
    const log = await readLog(h);
    expect(log.at(-1)).toMatchObject({ action: 'keep' });
  });

  it('does nothing when the router config is disabled', async () => {
    const h = await harness({
      currentModel: 'provider/max',
      routerConfig: { enabled: false, tiers: TIERS },
    });
    const { ctx, next } = promptCtx('Fix a typo in the readme');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).not.toHaveBeenCalled();
    await expect(readFile(join(h.dir, ROUTER_LOG_FILE), 'utf-8')).rejects.toThrow();
  });

  it('does nothing when the experimental flag is off', async () => {
    const h = await harness({ currentModel: 'provider/max', flagEnabled: false });
    const { ctx, next } = promptCtx('Fix a typo in the readme');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it('reports an unknown tier model without breaking the turn', async () => {
    const h = await harness({
      currentModel: 'provider/fast',
      routerConfig: {
        enabled: true,
        tiers: { ...TIERS, T2: { model: 'provider/ghost' } },
      },
    });
    const { ctx, next } = promptCtx('Debug the race condition in the worker pool');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('provider/ghost'));
    const log = await readLog(h);
    expect(log.at(-1)).toMatchObject({ action: 'error', detail: expect.stringContaining('provider/ghost') });
  });

  it('preserves the profile data while switching models mid-session', async () => {
    const h = await harness({ currentModel: 'provider/max' });
    const { ctx, next } = promptCtx('Fix a typo in the readme');
    await h.submitPromptHook(ctx, next);
    expect(h.setModel).toHaveBeenCalledTimes(1);
    expect(h.getModelChangeSource).toHaveBeenCalled();
  });

  it('escalates once on a failing turn and retries with the stronger model', async () => {
    const h = await harness({
      currentModel: 'provider/max',
      routerConfig: { enabled: true, maxEscalationsPerTurn: 1, tiers: TIERS },
    });
    const bounded = promptCtx('Fix the off-by-one error in paginate and add a unit test');
    await h.submitPromptHook(bounded.ctx);
    expect(h.setModel).toHaveBeenCalledWith('provider/fast', 'router');
    h.setModel.mockClear();

    const failure = errorCtx(7);
    expect(h.errorHandler.match(failure)).toBe(true);
    const handled = await h.errorHandler.handle(failure);
    expect(handled).toBe(true);
    expect(h.setModel).toHaveBeenCalledWith('provider/smart', 'router');
    expect(h.invalidateTurnConfig).toHaveBeenCalledWith(7);
    expect(failure.retry).toHaveBeenCalledTimes(1);
  });

  it('does not escalate beyond the budget, avoiding retry loops', async () => {
    const h = await harness({
      currentModel: 'provider/max',
      routerConfig: { enabled: true, maxEscalationsPerTurn: 1, tiers: TIERS },
    });
    await h.submitPromptHook(
      promptCtx('Fix the off-by-one error in paginate and add a unit test').ctx,
    );

    const first = errorCtx(1);
    expect(await h.errorHandler.handle(first)).toBe(true);
    h.setModel.mockClear();

    const second = errorCtx(1);
    expect(h.errorHandler.match(second)).toBe(false);
    expect(await h.errorHandler.handle(second)).toBe(false);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
  });

  it('does not escalate when the user picked the model explicitly', async () => {
    const h = await harness({ currentModel: 'provider/max', modelSource: 'user' });
    await h.submitPromptHook(promptCtx('Find the file where the router config is loaded').ctx);
    const failure = errorCtx(3);
    expect(h.errorHandler.match(failure)).toBe(false);
    expect(await h.errorHandler.handle(failure)).toBe(false);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it('routes subagent spawns through the tier model when a pool is configured', async () => {
    const h = await harness({
      routerConfig: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
      secondaryModel: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'cheap', 'provider/smart': 'strong' },
      },
    });
    const hard = h.service.routeSubagent('Debug the race condition in the scheduler', undefined);
    expect(hard).toBe('provider/smart');
    const trivial = h.service.routeSubagent('List the files under src/router', undefined);
    expect(trivial).toBe('provider/fast');
    const explicit = h.service.routeSubagent('Debug the race condition', 'provider/max');
    expect(explicit).toBe('provider/max');
    const log = await readLog(h);
    expect(log.some((entry) => entry['kind'] === 'subagent' && entry['model'] === 'provider/smart')).toBe(true);
  });

  it('lets subagents inherit the caller model when no pool is configured', async () => {
    const h = await harness({
      routerConfig: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
    });
    expect(h.service.routeSubagent('Debug the race condition', undefined)).toBeUndefined();
  });

  it('omits the model parameter when subagent routing is disabled', async () => {
    const h = await harness({
      routerConfig: { enabled: true, subagents: { enabled: false }, tiers: TIERS },
      secondaryModel: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'cheap', 'provider/smart': 'strong' },
      },
    });
    expect(h.service.routeSubagent('Debug the race condition', undefined)).toBeUndefined();
  });
});
