import {validateHostToolsConfig} from './host-tools-config.ts';
import {ConfiguredHostTools,type ConfiguredHostToolsOptions} from './host-tools-service.ts';
import type {ConnectorConfig} from './connector-config.ts';
export {HOST_CONNECTOR_PATH as CONNECTOR_CALLBACK_PATH} from './host-tools-listener.ts';
export interface ConfiguredConnectorOptions extends Omit<ConfiguredHostToolsOptions,'config'|'calendarFactory'|'ownerAuthenticationConfigured'>{config:ConnectorConfig}
/** Byte-compatible legacy config/constructor backed by the same single listener. */
export class ConfiguredConnectors extends ConfiguredHostTools{
  constructor(options:ConfiguredConnectorOptions){super({...options,config:validateHostToolsConfig(options.config)});}
}
export type ConnectorServiceStatus=ReturnType<ConfiguredConnectors['snapshot']>;
