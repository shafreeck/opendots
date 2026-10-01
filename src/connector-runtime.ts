import { CONNECTOR_TOOL } from './connector-types.ts';
import { NativeHostAuthority, type NativeHostAuthorityOptions } from './native-host-authority.ts';

/** Legacy connector contract remains pinned to its own tool name. */
export type ConnectorRuntimeOptions = Omit<NativeHostAuthorityOptions, 'toolName'>;
export class ConnectorRuntimeClient extends NativeHostAuthority {
  constructor(options: ConnectorRuntimeOptions) { super({ ...options, toolName: CONNECTOR_TOOL }); }
}
