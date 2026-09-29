export * from './capabilities';
export * from './driver';
export * from './engines';
export * from './errors';
export * from './profile';
export * from './results';
export * from './schema';
export * from './version';

/** A random UUID; works in Node.js and the renderer. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
