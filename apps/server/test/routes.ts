import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { z, type ZodType } from 'zod';
import { AUTHZ, type AuthzRule } from '../src/common/authz.js';
import { uuidv7 } from './helpers.js';

/** Nest's metadata keys (see @nestjs/common/constants) and parameter kinds (RouteParamtypes). */
const PATH = 'path';
const METHOD = 'method';
const ROUTE_ARGS = '__routeArguments__';
const INTERCEPTORS = '__interceptors__';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'] as const;
const BODY = 3;
const QUERY = 4;
const PARAM = 5;

export type HttpMethod = (typeof METHODS)[number];

export interface RouteInfo {
  method: HttpMethod;
  /** As Express sees it: `/api/teams/:id`. */
  path: string;
  /** `GET /api/teams/:id` */
  key: string;
  controller: string;
  handler: string;
  rule: AuthzRule | undefined;
  body?: ZodType;
  query?: ZodType;
  /** Validation of named path parameters. */
  params: Record<string, ZodType | undefined>;
  /** Takes a file upload (multipart). */
  multipart: boolean;
}

const clean = (p: unknown): string => String(p ?? '').replace(/^\/+|\/+$/g, '');

/** Every route of the running app, read from the controllers' metadata (the same data Nest builds its router from). */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const modules = app.get(ModulesContainer);
  const out: RouteInfo[] = [];
  const seen = new Set<unknown>();
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!cls || seen.has(cls)) continue;
      seen.add(cls);
      const bases = [Reflect.getMetadata(PATH, cls) as string | string[] | undefined].flat();
      const classRule = Reflect.getMetadata(AUTHZ, cls) as AuthzRule | undefined;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        // a getter would run against the prototype: only plain methods can be routes
        const fn = Object.getOwnPropertyDescriptor(cls.prototype, name)?.value as unknown;
        if (typeof fn !== 'function') continue;
        const sub = Reflect.getMetadata(PATH, fn) as string | string[] | undefined;
        const m = Reflect.getMetadata(METHOD, fn) as number | undefined;
        if (sub === undefined || m === undefined) continue;
        const args = (Reflect.getMetadata(ROUTE_ARGS, cls, name) ?? {}) as Record<
          string,
          { index: number; data?: unknown; schema?: ZodType }
        >;
        let body: ZodType | undefined;
        let query: ZodType | undefined;
        const params: Record<string, ZodType | undefined> = {};
        for (const [k, v] of Object.entries(args)) {
          const type = Number(k.split(':')[0]);
          if (type === BODY && !v.data) body = v.schema;
          if (type === QUERY && !v.data) query = v.schema;
          if (type === PARAM && typeof v.data === 'string') params[v.data] = v.schema;
          if (type === PARAM && !v.data && v.schema) params['*'] = v.schema;
        }
        const multipart =
          ((Reflect.getMetadata(INTERCEPTORS, fn) as unknown[] | undefined) ?? []).length > 0;
        for (const b of bases)
          for (const s of [sub].flat()) {
            const path = `/${['api', clean(b), clean(s)].filter(Boolean).join('/')}`;
            const method = METHODS[m]!;
            out.push({
              method,
              path,
              key: `${method} ${path}`,
              controller: cls.name,
              handler: name,
              rule: (Reflect.getMetadata(AUTHZ, fn) as AuthzRule | undefined) ?? classRule,
              body,
              query,
              params,
              multipart,
            });
          }
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** `:id` names in a path, in order. */
export const paramNames = (path: string): string[] =>
  [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);

// ------------------------------------------------------------------ sample values generated from the zod schemas

interface Json {
  type?: string | string[];
  properties?: Record<string, Json>;
  required?: string[];
  items?: Json;
  prefixItems?: Json[];
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: Json[];
  oneOf?: Json[];
  allOf?: Json[];
  $ref?: string;
  $defs?: Record<string, Json>;
  additionalProperties?: Json | boolean;
}

/** Strings tried against a `pattern` until one matches (the shapes this API uses: positions, colours, permission bit fields, ...). */
const PATTERN_CANDIDATES = [
  'a0',
  '#336699',
  '0',
  '1',
  'abc',
  'a',
  'x',
  'Europe/Lisbon',
  '09:00',
  '2026-12-01',
  'en',
  'a-b',
  'FREQ=WEEKLY',
];

let clock = Date.UTC(2026, 11, 1, 9, 0, 0);

/** A value the schema accepts, built from its JSON Schema: required fields only, the smallest valid strings and numbers. */
export function sample(schema: ZodType): unknown {
  clock = Date.UTC(2026, 11, 1, 9, 0, 0);
  const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return fromJson(root, root, 0);
}

function fromJson(s: Json, root: Json, depth: number): unknown {
  if (depth > 8) return undefined;
  if (s.$ref) {
    const name = s.$ref.replace(/^#\/\$defs\//, '');
    const target = s.$ref === '#' ? root : root.$defs?.[name];
    return target ? fromJson(target, root, depth + 1) : {};
  }
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.default !== undefined) return s.default;
  for (const options of [s.anyOf, s.oneOf]) {
    if (options?.length) {
      const pick = options.find((o) => o.type !== 'null') ?? options[0]!;
      return fromJson(pick, root, depth + 1);
    }
  }
  if (s.allOf?.length) return fromJson(Object.assign({}, ...s.allOf), root, depth + 1);
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? s.type[0]) : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of s.required ?? []) {
        const v = fromJson(s.properties?.[key] ?? {}, root, depth + 1);
        if (v !== undefined) out[key] = v;
      }
      return out;
    }
    case 'array': {
      if (s.prefixItems) return s.prefixItems.map((p) => fromJson(p, root, depth + 1));
      const n = s.minItems ?? 0;
      return Array.from({ length: n }, () => fromJson(s.items ?? {}, root, depth + 1));
    }
    case 'string':
      return stringFor(s);
    case 'integer':
    case 'number': {
      if (s.minimum !== undefined) return s.minimum;
      if (s.exclusiveMinimum !== undefined)
        return type === 'integer' ? Math.floor(s.exclusiveMinimum) + 1 : s.exclusiveMinimum + 1;
      return s.maximum !== undefined && s.maximum < 0 ? s.maximum : 0;
    }
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return s.properties ? fromJson({ ...s, type: 'object' }, root, depth) : undefined;
  }
}

let counter = 0;
function stringFor(s: Json): string {
  switch (s.format) {
    case 'uuid':
      return uuidv7();
    case 'email':
      return `sample${Date.now()}${counter++}@example.com`;
    case 'uri':
    case 'url':
      return 'https://example.com/sample';
    case 'date-time':
      clock += 3_600_000;
      return new Date(clock).toISOString();
    case 'date':
      return '2026-12-01';
    case 'time':
      return '10:00:00';
  }
  if (s.pattern) {
    const re = new RegExp(s.pattern);
    const fit = PATTERN_CANDIDATES.find(
      (c) => re.test(c) && c.length >= (s.minLength ?? 0) && c.length <= (s.maxLength ?? 1e9),
    );
    if (fit) return fit;
  }
  const len = Math.max(s.minLength ?? 1, 1);
  return 'sample'.padEnd(len, 'x').slice(0, Math.max(len, Math.min(6, s.maxLength ?? 6)));
}
