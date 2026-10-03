/**
 * @querybara/ipc — typed RPC over MessagePort (spec §3, "IPC contract"). Contracts are zod schemas
 * validated on both ends; streams use credit-based flow control; every call can be cancelled.
 * No Electron import: this runs in the renderer, the main and utility processes, the CLI and tests.
 */

export {
  fromDomPort,
  fromElectronPort,
  fromNodePort,
  type DomMessagePortLike,
  type ElectronMessagePortLike,
  type NodeMessagePortLike,
  type PortLike,
} from './port';

export {
  defineContract,
  parseRequest,
  type CallOptions,
  type ClientOf,
  type Contract,
  type ContractShape,
  type HandlerContext,
  type HandlersOf,
  type MethodAt,
  type MethodDef,
  type MethodEntry,
  type MethodPath,
  type RequestOf,
  type RpcStream,
  type ShapeOf,
  type StreamCall,
  type StreamHandler,
  type StreamMethodDef,
  type UnaryCall,
  type UnaryHandler,
  type UnaryMethodDef,
} from './contract';

export { createClient, DEFAULT_STREAM_WINDOW, type Client, type ClientOptions } from './client';
export { serve, type Server } from './server';
export { MAX_STREAM_WINDOW, PROTOCOL_VERSION } from './protocol';

export * from './schemas/common';
export * from './schemas/results';
export * from './schemas/driver';
export * from './schemas/app';
export * from './schemas/table-data';
export * from './schemas/metadata';
export * from './schemas/jobs';
export * from './schemas/transfer-db';
export * from './schemas/mongo';
export * from './schemas/redis';
export * from './schemas/sync';
export * from './schemas/server-tools';
export * from './schemas/workspace';
export * from './schemas/er-models';
export * from './schemas/schedules';
export * from './schemas/backup';
export * from './schemas/search';
export * from './schemas/updates';

export {
  connectionHostContract,
  serverInfoSchema,
  type ConnectionHostContract,
  type ServerInfo,
} from './contracts/connection-host';
export { mainContract, type MainContract } from './contracts/main';
export { mongoHostContractShape, mongoMainContractShape } from './contracts/mongo';
export { transferDbMainContractShape } from './contracts/transfer-db';
export { backupMainContractShape } from './contracts/backup';
export { redisHostContractShape } from './contracts/redis';
export { syncMainContractShape } from './contracts/sync';
export { serverToolsHostContractShape } from './contracts/server-tools';
export { autosaveMainContractShape, gridViewsMainContractShape } from './contracts/workspace';
export { erModelsMainContractShape } from './contracts/er-models';
export { schedulesMainContractShape } from './contracts/schedules';
export { redisDumpMainContractShape } from './contracts/redis-dump';
export { searchHostContractShape } from './contracts/search';
export { updatesMainContractShape } from './contracts/updates';
