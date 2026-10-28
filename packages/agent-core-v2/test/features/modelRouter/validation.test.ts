import { describe, expect, it } from 'vitest';

import { isError2 } from '#/errors';
import { assertValidModelRouterConfig } from '#/features/modelRouter/validation';
import type { IModelCatalog } from '#/llm-adapter/model/catalog';
import { stubConfigService } from '../../app/config/stubs';

const catalog = {
  _serviceBrand: undefined,
  get: (alias: string) => {
    if (alias !== 'provider/fast' && alias !== 'provider/smart') {
      throw new Error(`unknown model ${alias}`);
    }
    return { alias };
  },
} as unknown as IModelCatalog;

describe('assertValidModelRouterConfig', () => {
  it('passes when the router is disabled', () => {
    const config = stubConfigService({
      modelRouter: { enabled: false, tiers: { T2: { model: 'provider/ghost' } } },
    });
    expect(() => assertValidModelRouterConfig(config, catalog, true)).not.toThrow();
  });

  it('passes when the flag is inactive even if the config is enabled', () => {
    const config = stubConfigService({
      modelRouter: { enabled: true, tiers: { T2: { model: 'provider/ghost' } } },
    });
    expect(() => assertValidModelRouterConfig(config, catalog, false)).not.toThrow();
  });

  it('accepts tier models that resolve in the catalog', () => {
    const config = stubConfigService({
      modelRouter: {
        enabled: true,
        tiers: { T0: { model: 'provider/fast' }, T2: { model: 'provider/smart' } },
      },
    });
    expect(() => assertValidModelRouterConfig(config, catalog, true)).not.toThrow();
  });

  it('fails loudly naming the tier and the unknown alias', () => {
    const config = stubConfigService({
      modelRouter: {
        enabled: true,
        tiers: { T2: { model: 'provider/ghost' } },
      },
    });
    let caught: unknown;
    try {
      assertValidModelRouterConfig(config, catalog, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isError2(caught)).toBe(true);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('T2');
    expect(message).toContain('provider/ghost');
    expect(message).toContain('[model_router.tiers.T2].model');
  });
});
