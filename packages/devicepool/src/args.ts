import { DevicepoolError } from './client/index.ts';

const HINT = 'Run `devicepool help`.';

export function usageError(message: string): DevicepoolError {
  return new DevicepoolError(0, 'USAGE', message);
}

export function usageProblem(err: unknown): string | null {
  if (!(err instanceof Error) || !('code' in err) || typeof err.code !== 'string' || !err.code.startsWith('ERR_PARSE_ARGS')) {
    return null;
  }
  const name = /'(--?[\w-]+)/.exec(err.message)?.[1];
  switch (err.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return `Unknown option${name ? ` ${name}` : ''}. ${HINT}`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return /does not take an argument/.test(err.message) ? `${name ?? 'An option'} does not take a value. ${HINT}` : `${name ?? 'An option'} needs a value. ${HINT}`;
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': {
      const word = /'([^']+)'/.exec(err.message)?.[1];
      return `Unexpected argument${word ? ` ${word}` : ''}. ${HINT}`;
    }
    default:
      return `${err.message.split('. ')[0]}. ${HINT}`;
  }
}

export function intOption(flag: string, value: string | undefined, min: number, max?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `${min} or more` : `from ${min} to ${max}`;
    throw usageError(`${flag} must be a whole number, ${range}. You gave "${value}". ${HINT}`);
  }
  return n;
}

export function seconds(flag: string, value: string | undefined): number | undefined {
  return intOption(flag, value, 1);
}

export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

export function unknownCommand(command: string): string {
  return `Unknown command "${command}". ${HINT}`;
}

export function unexpectedMessage(err: unknown): string {
  return `${err instanceof Error ? err.message : String(err)}\nSet DEVICEPOOL_DEBUG=1 to see the full error.`;
}
