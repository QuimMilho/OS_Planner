import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  StandardSchemaValidationPipe,
} from '@nestjs/common';

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);

/**
 * Fields of `input` that the schema did not keep in `output` (dotted paths), compared object by object and array item by item.
 * A zod object drops what it does not know, so whatever is missing from the parsed value is a field nobody declared. Where the
 * schema turned a value into something of another shape (a JSON string into an object, a list into a string) nothing is compared.
 */
export function unknownKeys(input: unknown, output: unknown, path = ''): string[] {
  if (Array.isArray(input) && Array.isArray(output) && input.length === output.length)
    return input.flatMap((v, i) => unknownKeys(v, output[i], `${path}${i}.`));
  if (!isPlain(input) || !isPlain(output)) return [];
  const extra: string[] = [];
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(output, key)) extra.push(`${path}${key}`);
    else extra.push(...unknownKeys(input[key], output[key], `${path}${key}.`));
  }
  return extra;
}

/**
 * The validation of every body and query string (phase 17, mass assignment): what the zod schema of the route accepts, and
 * nothing else. A field the schema does not declare is a 400, so a client never believes a field it sent was applied (and
 * nothing a client sends can reach a service unless a schema names it).
 */
@Injectable()
export class StrictSchemaPipe extends StandardSchemaValidationPipe {
  override async transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
    const out = await super.transform(value, metadata);
    if (metadata.schema && (metadata.type === 'body' || metadata.type === 'query')) {
      const extra = unknownKeys(value, out);
      if (extra.length)
        throw new BadRequestException(extra.slice(0, 10).map((k) => `${k}: unknown field`));
    }
    return out;
  }
}
