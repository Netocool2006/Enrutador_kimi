import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/llm-adapter/model/catalog';

import { MODEL_ROUTER_FLAG_ID } from './flag';
import { assertValidModelRouterConfig } from './validation';

export interface ISessionModelRouterValidationService {
  readonly _serviceBrand: undefined;
}

export const ISessionModelRouterValidationService: ServiceIdentifier<ISessionModelRouterValidationService> =
  createDecorator<ISessionModelRouterValidationService>('sessionModelRouterValidationService');

export class SessionModelRouterValidationService
  implements ISessionModelRouterValidationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @IModelCatalog modelCatalog: IModelCatalog,
    @IFlagService flags: IFlagService,
  ) {
    assertValidModelRouterConfig(config, modelCatalog, flags.enabled(MODEL_ROUTER_FLAG_ID));
  }
}
