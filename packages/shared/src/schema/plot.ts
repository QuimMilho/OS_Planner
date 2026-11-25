import { SERIES_PALETTE } from './render-config';
import type { PlotExpression, PlotSpec } from './specs';

/**
 * Function plots without `eval`. Expressions are parsed into closures by a small recursive-descent
 * parser, so nothing the author types can ever execute as code (which also keeps the strict
 * Content-Security-Policy intact), and the plot is drawn as SVG: identical in the editor and in a PDF.
 */

export type Scope = Record<string, number>;
export type Compiled = (scope: Scope) => number;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2, hypot: Math.hypot,
  mod: (a, b) => ((a % b) + b) % b,
};

/** Own-property lookup only: "constructor", "__proto__" and friends must never resolve to something on Object.prototype. */
const own = <T>(table: Record<string, T>, name: string): T | undefined => (Object.hasOwn(table, name) ? table[name] : undefined);

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      // A number, with an exponent only when "e" is followed by digits ("2e" means 2 times e).
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new SyntaxError(`unexpected "${c}"`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if ('+-*/^(),'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
    } else throw new SyntaxError(`unexpected "${c}"`);
  }
  return out;
}

/** Parses an expression. `variables` are the names allowed besides the constants (pi, e, tau). */
export function compileExpression(source: string, variables: readonly string[]): Compiled {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
  const eat = (v: string) => {
    if (!isOp(v)) throw new SyntaxError(`expected "${v}"`);
    pos++;
  };
  /** True when the next token can start an operand (for implicit multiplication: 2x, 2(x+1), x sin(x)). */
  const startsOperand = () => {
    const tok = peek();
    return !!tok && (tok.t === 'num' || tok.t === 'id' || (tok.t === 'op' && tok.v === '('));
  };

  function expr(): Compiled {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const plus = (peek() as { v: string }).v === '+';
      pos++;
      const l = left;
      const r = term();
      left = plus ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
    return left;
  }

  function term(): Compiled {
    let left = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const times = (peek() as { v: string }).v === '*';
        pos++;
        const l = left;
        const r = unary();
        left = times ? (s) => l(s) * r(s) : (s) => l(s) / r(s);
      } else if (startsOperand()) {
        const l = left;
        const r = unary();
        left = (s) => l(s) * r(s);
      } else return left;
    }
  }

  function unary(): Compiled {
    if (isOp('-')) {
      pos++;
      const inner = unary();
      return (s) => -inner(s);
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    return power();
  }

  /** `^` binds tighter than unary minus on its left (-x^2 = -(x^2)) and is right-associative. */
  function power(): Compiled {
    const base = atom();
    if (isOp('^')) {
      pos++;
      const exponent = unary();
      return (s) => Math.pow(base(s), exponent(s));
    }
    return base;
  }

  function atom(): Compiled {
    const tok = tokens[pos++];
    if (!tok) throw new SyntaxError('unexpected end of expression');
    if (tok.t === 'num') {
      const v = tok.v;
      return () => v;
    }
    if (tok.t === 'op') {
      if (tok.v !== '(') throw new SyntaxError(`unexpected "${tok.v}"`);
      const inner = expr();
      eat(')');
      return inner;
    }
    const name = tok.v;
    const fn = own(FUNCTIONS, name);
    if (isOp('(') && fn) {
      pos++;
      const args: Compiled[] = [];
      if (!isOp(')')) {
        do args.push(expr());
        while (isOp(',') && ++pos);
      }
      eat(')');
      return (s) => fn(...args.map((a) => a(s)));
    }
    const constant = own(CONSTANTS, name);
    if (constant !== undefined) return () => constant;
    if (variables.includes(name)) return (s) => s[name] ?? NaN;
    throw new SyntaxError(fn ? `"${name}" needs arguments: ${name}(…)` : `unknown name "${name}"`);
  }

  const result = expr();
  if (pos < tokens.length) throw new SyntaxError(`unexpected "${(tokens[pos] as { v: string | number }).v}"`);
  return result;
}

// ---------------------------------------------------------------- sampling

type Point = readonly [number, number];
interface Series {
  color: string;
  /** Polylines: a new one starts wherever the curve is undefined or jumps (asymptotes). */
  lines: Point[][];
}

const SAMPLES = 700;

function sampleExpression(e: PlotExpression, xDomain: readonly [number, number]): { points: (Point | null)[] } {
  const pts: (Point | null)[] = [];
  const push = (x: number, y: number) => pts.push(Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null);
  if (e.kind === 'linear') {
    const f = compileExpression(e.fn, ['x']);
    for (let i = 0; i <= SAMPLES; i++) {
      const x = xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / SAMPLES;
      push(x, f({ x }));
    }
  } else if (e.kind === 'parametric') {
    const fx = compileExpression(e.x, ['t']);
    const fy = compileExpression(e.y, ['t']);
    for (let i = 0; i <= SAMPLES; i++) {
      const t = (2 * Math.PI * i) / SAMPLES;
      push(fx({ t }), fy({ t }));
    }
  } else {
    const r = compileExpression(e.r, ['theta']);
    for (let i = 0; i <= SAMPLES; i++) {
      const theta = (2 * Math.PI * i) / SAMPLES;
      const radius = r({ theta });
      push(radius * Math.cos(theta), radius * Math.sin(theta));
    }
  }
  return { points: pts };
}

/** Rounds to a 1/2/5 x 10^n step so axis labels are human-friendly. */
export function niceStep(span: number, targetTicks: number): number {
  const raw = span / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

const fmt = (v: number): string => {
  if (Math.abs(v) < 1e-12) return '0';
  const s = Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(1) : String(Number(v.toPrecision(4)));
  return s.replace('-', '−');
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PlotResult {
  svg: string;
  /** One message per expression that could not be drawn (syntax errors, unknown names). */
  errors: string[];
}

let clipCounter = 0;

/** Draws the plot as a self-contained SVG string. Text and grid use `currentColor`, so it follows light/dark themes. */
export function renderPlotSvg(spec: PlotSpec, size: { width: number; height?: number }): PlotResult {
  const width = Math.max(240, Math.round(size.width));
  const height = Math.round(size.height ?? width * 0.55);
  const m = { left: 46, right: 14, top: spec.title ? 34 : 14, bottom: 30 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;

  const errors: string[] = [];
  const raw: { color: string; points: (Point | null)[] }[] = [];
  spec.expressions.forEach((e, i) => {
    try {
      raw.push({ color: e.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]!, points: sampleExpression(e, spec.xDomain).points });
    } catch (err) {
      errors.push(`${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const [x0, x1] = spec.xDomain[0] < spec.xDomain[1] ? spec.xDomain : ([spec.xDomain[1], spec.xDomain[0]] as const);
  // y range: as given, or fitted to the data ignoring the extreme 2% so asymptotes do not flatten the curve.
  let y0: number;
  let y1: number;
  if (spec.yDomain && spec.yDomain[0] < spec.yDomain[1]) [y0, y1] = spec.yDomain;
  else {
    const ys = raw.flatMap((s) => s.points.filter((p): p is Point => !!p && p[0] >= x0 && p[0] <= x1).map((p) => p[1])).sort((a, b) => a - b);
    if (ys.length) {
      const lo = ys[Math.floor(ys.length * 0.02)]!;
      const hi = ys[Math.ceil(ys.length * 0.98) - 1]!;
      const pad = (hi - lo || 1) * 0.08;
      [y0, y1] = [lo - pad, hi + pad];
    } else [y0, y1] = [-1, 1];
  }

  const sx = (x: number) => m.left + ((x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => m.top + (1 - (y - y0) / (y1 - y0)) * ph;
  const jump = (y1 - y0) * 1.5; // a step this tall between neighbours is an asymptote, not a line

  const series: Series[] = raw.map(({ color, points }) => {
    const lines: Point[][] = [];
    let current: Point[] = [];
    let last: Point | null = null;
    for (const p of points) {
      if (!p || (last && Math.abs(p[1] - last[1]) > jump)) {
        if (current.length > 1) lines.push(current);
        current = [];
      }
      if (p) current.push(p);
      last = p;
    }
    if (current.length > 1) lines.push(current);
    return { color, lines };
  });

  const clip = `plot-clip-${++clipCounter}`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(spec.title || 'Plot')}" style="max-width:100%;height:auto;color:inherit" font-family="inherit" font-size="11">`);
  out.push(`<defs><clipPath id="${clip}"><rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}"/></clipPath></defs>`);
  if (spec.title) out.push(`<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">${esc(spec.title)}</text>`);

  const xs = niceStep(x1 - x0, Math.max(3, pw / 70));
  const ys = niceStep(y1 - y0, Math.max(3, ph / 45));
  for (let x = Math.ceil(x0 / xs) * xs; x <= x1 + xs * 1e-9; x += xs) {
    const px = sx(x);
    if (spec.grid) out.push(`<line x1="${px}" y1="${m.top}" x2="${px}" y2="${m.top + ph}" stroke="currentColor" stroke-opacity="0.12"/>`);
    out.push(`<text x="${px}" y="${m.top + ph + 16}" text-anchor="middle" fill="currentColor" fill-opacity="0.75">${fmt(x)}</text>`);
  }
  for (let y = Math.ceil(y0 / ys) * ys; y <= y1 + ys * 1e-9; y += ys) {
    const py = sy(y);
    if (spec.grid) out.push(`<line x1="${m.left}" y1="${py}" x2="${m.left + pw}" y2="${py}" stroke="currentColor" stroke-opacity="0.12"/>`);
    out.push(`<text x="${m.left - 6}" y="${py + 4}" text-anchor="end" fill="currentColor" fill-opacity="0.75">${fmt(y)}</text>`);
  }
  out.push(`<rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}" fill="none" stroke="currentColor" stroke-opacity="0.35"/>`);
  if (x0 < 0 && x1 > 0) out.push(`<line x1="${sx(0)}" y1="${m.top}" x2="${sx(0)}" y2="${m.top + ph}" stroke="currentColor" stroke-opacity="0.55"/>`);
  if (y0 < 0 && y1 > 0) out.push(`<line x1="${m.left}" y1="${sy(0)}" x2="${m.left + pw}" y2="${sy(0)}" stroke="currentColor" stroke-opacity="0.55"/>`);

  out.push(`<g clip-path="url(#${clip})" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">`);
  for (const s of series) {
    for (const line of s.lines) {
      out.push(`<polyline stroke="${s.color}" points="${line.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')}"/>`);
    }
  }
  out.push('</g></svg>');
  return { svg: out.join(''), errors };
}
