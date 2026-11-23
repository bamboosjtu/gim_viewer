import {
  NATIVE_ERROR_CODES,
  type NativeError,
  type NativeErrorCode,
  type NativeErrorContext,
} from "./generated/nativeContracts.js";
export type {
  NativeError,
  NativeErrorCode,
  NativeErrorContext,
} from "./generated/nativeContracts.js";

const knownCodes = new Set<string>(NATIVE_ERROR_CODES);
export class GimError extends Error implements NativeError {
  constructor(
    readonly code: NativeErrorCode,
    message: string,
    readonly context?: NativeErrorContext | null,
  ) {
    super(message);
    this.name = "GimError";
  }
  toString(): string {
    return this.message;
  }
}
/** One error object only. No payload scan and no interpretation of display messages. */
export function nativeError(error: unknown): GimError {
  if (error instanceof GimError) return error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    knownCodes.has(error.code) &&
    typeof error.message === "string"
  ) {
    return new GimError(
      error.code as NativeErrorCode,
      error.message,
      "context" in error
        ? (error.context as NativeErrorContext | null)
        : undefined,
    );
  }
  return new GimError(
    "PROTOCOL_INVALID",
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "原生错误响应不符合 v1 契约",
  );
}
export function hasErrorCode(
  error: unknown,
  ...codes: readonly NativeErrorCode[]
): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    knownCodes.has(error.code) &&
    codes.includes(error.code as NativeErrorCode)
  );
}
