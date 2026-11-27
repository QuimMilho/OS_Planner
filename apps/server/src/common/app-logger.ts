import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { scrubAny } from './scrub.js';

/** LOG_LEVEL -> the levels Nest prints (each level includes the ones above it). */
export function logLevels(level: 'error' | 'warn' | 'log' | 'debug' | 'verbose'): LogLevel[] {
  const order: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
  return order.slice(0, order.indexOf(level) + 1);
}

/**
 * The server's logger: Nest's console logger (JSON lines with LOG_FORMAT=json, the default in production) with every message
 * scrubbed of tokens and secret addresses first (see scrub.ts).
 */
export class AppLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    super.log(scrubAny(message), ...rest.map(scrubAny));
  }
  override error(message: unknown, ...rest: unknown[]): void {
    super.error(scrubAny(message), ...rest.map(scrubAny));
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(scrubAny(message), ...rest.map(scrubAny));
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    super.debug(scrubAny(message), ...rest.map(scrubAny));
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(scrubAny(message), ...rest.map(scrubAny));
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(scrubAny(message), ...rest.map(scrubAny));
  }
}
