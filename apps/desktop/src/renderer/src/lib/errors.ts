import { JoineryError, type ErrorData } from '@joinery/core';

/** The serialisable details of anything thrown, for messages and banners. */
export function errorInfo(error: unknown): ErrorData {
  if (error instanceof JoineryError) return error.toJSON();
  if (error instanceof Error) return { code: 'INTERNAL', message: error.message };
  return { code: 'INTERNAL', message: String(error) };
}

export function errorMessage(error: unknown): string {
  const info = errorInfo(error);
  return info.hint ? `${info.message}. ${info.hint}` : info.message;
}
