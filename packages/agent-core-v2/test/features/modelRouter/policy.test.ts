import { describe, expect, it } from 'vitest';

import {
  planEscalation,
  planSubagentRouting,
  planTurnRouting,
  routerActive,
  type ModelRouterConfig,
} from '#/features/modelRouter/policy';

const TIERS: ModelRouterConfig['tiers'] = {
  T0: { model: 'provider/fast' },
  T1: { model: 'provider/fast' },
  T2: { model: 'provider/smart' },
  T3: { model: 'provider/max' },
};

const KNOWN_MODELS = new Set(['provider/fast', 'provider/smart', 'provider/max']);
const hasModel = (alias: string): boolean => KNOWN_MODELS.has(alias);

function turnInput(overrides: {
  text: string;
  currentModel?: string;
  modelSource?: 'startup' | 'user' | 'router' | 'migration' | 'spawn';
  config?: ModelRouterConfig;
  hasModelFn?: (alias: string) => boolean;
}) {
  return {
    text: overrides.text,
    currentModel: overrides.currentModel ?? 'provider/smart',
    modelSource: overrides.modelSource ?? 'startup',
    config: overrides.config ?? { enabled: true, tiers: TIERS },
    hasModel: overrides.hasModelFn ?? hasModel,
  };
}

describe('planTurnRouting', () => {
  it('routes a trivial task to the low tier model instead of the high tier model', () => {
    const decision = planTurnRouting(
      turnInput({ text: 'Find the file where config is loaded', currentModel: 'provider/max' }),
    );
    expect(decision.kind).toBe('switch');
    if (decision.kind !== 'switch') return;
    expect(decision.model).toBe('provider/fast');
    expect(decision.classification.tier).toBe('T0');
  });

  it('routes a complex task to the configured complex-tier model', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'Debug the race condition between the worker pool and the scheduler',
        currentModel: 'provider/fast',
      }),
    );
    expect(decision.kind).toBe('switch');
    if (decision.kind !== 'switch') return;
    expect(decision.model).toBe('provider/smart');
    expect(decision.classification.tier).toBe('T2');
  });

  it('routes an ambiguous task conservatively to an upper tier', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'I need you to take a look at something in the repository when you have a moment',
        currentModel: 'provider/fast',
      }),
    );
    expect(decision.kind).toBe('switch');
    if (decision.kind !== 'switch') return;
    expect(['T1', 'T2']).toContain(decision.classification.tier);
    expect(decision.classification.uncertain).toBe(true);
    expect(decision.model).not.toBe('provider/fast');
  });

  it('keeps the current model when the user chose it explicitly', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'Rename this variable everywhere',
        currentModel: 'provider/max',
        modelSource: 'user',
      }),
    );
    expect(decision.kind).toBe('keep');
    if (decision.kind !== 'keep') return;
    expect(decision.reason).toBe('user-model-choice');
  });

  it('still routes when respectUserChoice is disabled', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'Rename this variable everywhere',
        currentModel: 'provider/max',
        modelSource: 'user',
        config: { enabled: true, respectUserChoice: false, tiers: TIERS },
      }),
    );
    expect(decision.kind).toBe('switch');
  });

  it('reports an unknown tier model as a clear error', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'Debug the intermittent failure in the test suite',
        config: {
          enabled: true,
          tiers: { ...TIERS, T2: { model: 'provider/ghost' } },
        },
      }),
    );
    expect(decision.kind).toBe('error');
    if (decision.kind !== 'error') return;
    expect(decision.message).toContain('provider/ghost');
    expect(decision.message).toContain('T2');
  });

  it('keeps the current model when already on the tier model', () => {
    const decision = planTurnRouting(
      turnInput({ text: 'Fix a typo in the readme', currentModel: 'provider/fast' }),
    );
    expect(decision.kind).toBe('keep');
    if (decision.kind !== 'keep') return;
    expect(decision.reason).toBe('already-on-model');
  });

  it('keeps the current model when the tier has no model configured', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'Rename foo to bar',
        config: { enabled: true, tiers: { T1: { model: 'provider/fast' } } },
      }),
    );
    expect(decision.kind).toBe('keep');
    if (decision.kind !== 'keep') return;
    expect(decision.reason).toBe('no-model-configured-for-tier');
  });

  it('returns a simulate decision in simulation mode without a switch payload difference', () => {
    const decision = planTurnRouting(
      turnInput({
        text: 'Fix a typo in the readme',
        currentModel: 'provider/smart',
        config: { enabled: true, simulation: true, tiers: TIERS },
      }),
    );
    expect(decision.kind).toBe('simulate');
    if (decision.kind !== 'simulate') return;
    expect(decision.model).toBe('provider/fast');
  });
});

describe('planEscalation', () => {
  it('escalates one tier with the configured model', () => {
    const plan = planEscalation({
      currentTier: 'T1',
      escalationsUsed: 0,
      config: { enabled: true, tiers: TIERS },
      hasModel,
    });
    expect(plan).toEqual({ tier: 'T2', model: 'provider/smart', effort: undefined });
  });

  it('stops after the configured escalation budget', () => {
    const config: ModelRouterConfig = {
      enabled: true,
      maxEscalationsPerTurn: 1,
      tiers: TIERS,
    };
    const first = planEscalation({ currentTier: 'T0', escalationsUsed: 0, config, hasModel });
    expect(first?.tier).toBe('T1');
    const second = planEscalation({ currentTier: 'T1', escalationsUsed: 1, config, hasModel });
    expect(second).toBeUndefined();
  });

  it('never escalates past T3', () => {
    const plan = planEscalation({
      currentTier: 'T3',
      escalationsUsed: 0,
      config: { enabled: true, tiers: TIERS },
      hasModel,
    });
    expect(plan).toBeUndefined();
  });

  it('skips tiers without a configured or known model', () => {
    const plan = planEscalation({
      currentTier: 'T1',
      escalationsUsed: 0,
      config: {
        enabled: true,
        tiers: { T1: { model: 'provider/fast' }, T2: { model: 'provider/ghost' }, T3: { model: 'provider/max' } },
      },
      hasModel,
    });
    expect(plan).toEqual({ tier: 'T3', model: 'provider/max', effort: undefined });
  });
});

describe('planSubagentRouting', () => {
  const pool = { 'provider/fast': 'cheap', 'provider/smart': 'strong' };

  it('always honors an explicit model choice', () => {
    const decision = planSubagentRouting({
      text: 'Find where the config is parsed',
      explicitModel: 'provider/smart',
      pool,
      poolDefault: 'provider/fast',
      config: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
      hasModel,
    });
    expect(decision.model).toBe('provider/smart');
    expect(decision.reason).toBe('explicit-model');
  });

  it('routes subagent tasks by tier when the tier model is in the pool', () => {
    const hard = planSubagentRouting({
      text: 'Debug the race condition in the scheduler',
      explicitModel: undefined,
      pool,
      poolDefault: 'provider/fast',
      config: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
      hasModel,
    });
    expect(hard.model).toBe('provider/smart');
    expect(hard.reason).toBe('tier-model');

    const trivial = planSubagentRouting({
      text: 'List the files under src/router',
      explicitModel: undefined,
      pool,
      poolDefault: 'provider/fast',
      config: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
      hasModel,
    });
    expect(trivial.model).toBe('provider/fast');
  });

  it('falls back to the pool default when the tier model is not in the pool', () => {
    const decision = planSubagentRouting({
      text: 'Redesign the persistence architecture',
      explicitModel: undefined,
      pool,
      poolDefault: 'provider/fast',
      config: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
      hasModel,
    });
    expect(decision.model).toBe('provider/fast');
    expect(decision.reason).toBe('pool-default');
  });

  it('inherits the caller model when subagent routing is disabled', () => {
    const decision = planSubagentRouting({
      text: 'Debug the race condition in the scheduler',
      explicitModel: undefined,
      pool,
      poolDefault: 'provider/fast',
      config: { enabled: true, subagents: { enabled: false }, tiers: TIERS },
      hasModel,
    });
    expect(decision.model).toBeUndefined();
  });

  it('inherits the caller model when no pool is configured', () => {
    const decision = planSubagentRouting({
      text: 'Debug the race condition in the scheduler',
      explicitModel: undefined,
      pool: undefined,
      poolDefault: undefined,
      config: { enabled: true, subagents: { enabled: true }, tiers: TIERS },
      hasModel,
    });
    expect(decision.model).toBeUndefined();
    expect(decision.reason).toBe('no-subagent-pool');
  });
});

describe('routerActive', () => {
  it('is inactive unless enabled is exactly true', () => {
    expect(routerActive({})).toBe(false);
    expect(routerActive({ enabled: false })).toBe(false);
    expect(routerActive({ enabled: true })).toBe(true);
  });
});
