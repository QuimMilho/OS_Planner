import { describe, expect, it } from 'vitest';
import { compileExpression, niceStep, renderPlotSvg } from './plot';
import { DEFAULT_PLOT_SPEC, type PlotSpec } from './specs';

const calc = (src: string, scope: Record<string, number> = {}, vars: string[] = Object.keys(scope)) => compileExpression(src, vars)(scope);

describe('expression parser', () => {
  it('follows operator precedence and associativity', () => {
    expect(calc('1 + 2 * 3')).toBe(7);
    expect(calc('(1 + 2) * 3')).toBe(9);
    expect(calc('2 ^ 3 ^ 2')).toBe(512); // right-associative
    expect(calc('-2 ^ 2')).toBe(-4); // unary minus applies after ^
    expect(calc('10 - 4 - 3')).toBe(3);
    expect(calc('8 / 4 / 2')).toBe(1);
  });

  it('evaluates variables, constants and functions', () => {
    expect(calc('x^2 + 1', { x: 3 })).toBe(10);
    expect(calc('sin(pi / 2)')).toBeCloseTo(1);
    expect(calc('ln(e)')).toBeCloseTo(1);
    expect(calc('max(1, 5, 3)')).toBe(5);
    expect(calc('sqrt(x)', { x: 16 })).toBe(4);
    expect(calc('mod(-1, 5)')).toBe(4);
    expect(calc('hypot(3, 4)')).toBe(5);
  });

  it('supports implicit multiplication', () => {
    expect(calc('2x', { x: 5 })).toBe(10);
    expect(calc('2(x + 1)', { x: 2 })).toBe(6);
    expect(calc('(x + 1)(x - 1)', { x: 3 })).toBe(8);
    expect(calc('3 sin(pi/2)')).toBeCloseTo(3);
    expect(calc('2e')).toBeCloseTo(2 * Math.E); // "e" is the constant unless digits follow
    expect(calc('1e3')).toBe(1000);
    expect(calc('1.5e-2')).toBeCloseTo(0.015);
  });

  it('gives NaN or Infinity for undefined values instead of throwing', () => {
    expect(calc('1 / 0')).toBe(Infinity);
    expect(calc('sqrt(-1)')).toBeNaN();
    expect(calc('ln(0)')).toBe(-Infinity);
  });

  it.each([
    ['', 'unexpected end'],
    ['1 +', 'unexpected end'],
    ['(1 + 2', 'expected ")"'],
    ['1 + * 2', 'unexpected "*"'],
    ['foo(1)', 'unknown name "foo"'],
    ['y', 'unknown name "y"'],
    ['sin', 'needs arguments'],
    ['1 2 )', 'unexpected ")"'],
    ['x; y', 'unexpected ";"'],
    ['@', 'unexpected "@"'],
  ])('rejects %j with a readable message', (src, message) => {
    expect(() => compileExpression(src, ['x'])).toThrow(message);
  });

  it('can never reach JavaScript: member access, strings, calls on values and globals are all rejected', () => {
    for (const hostile of ['constructor.constructor("alert(1)")()', 'x.y', 'globalThis', 'process', 'this', '[].map', '`a`', 'Function(1)()', '__proto__', 'x()', '(1)(2)(3)(']) {
      let result: unknown;
      try {
        result = compileExpression(hostile, ['x'])({ x: 1 });
      } catch {
        result = 'rejected';
      }
      // either rejected, or (for harmless arithmetic such as "(1)(2)") just a number
      expect(typeof result === 'number' || result === 'rejected').toBe(true);
    }
    // inherited properties of plain objects must not count as names
    for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => compileExpression(inherited, ['x']), inherited).toThrow('unknown name');
      expect(() => compileExpression(`${inherited}(1)`, ['x']), `${inherited}(1)`).toThrow();
    }
  });
});

describe('plot rendering', () => {
  const spec = (over: Partial<PlotSpec> = {}): PlotSpec => ({ ...structuredClone(DEFAULT_PLOT_SPEC), ...over });

  it('draws a curve with axes, labels and the title as real text', () => {
    const { svg, errors } = renderPlotSvg(spec({ title: 'Sinc <b>' }), { width: 640 });
    expect(errors).toEqual([]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<polyline');
    expect(svg).toContain('>Sinc &lt;b&gt;</text>'); // title is escaped text, not markup
    expect(svg).toContain('role="img"');
    expect(svg).not.toContain('<script');
  });

  it('is deterministic for the same input', () => {
    const a = renderPlotSvg(spec(), { width: 500 }).svg.replace(/plot-clip-\d+/g, 'c');
    const b = renderPlotSvg(spec(), { width: 500 }).svg.replace(/plot-clip-\d+/g, 'c');
    expect(a).toBe(b);
  });

  it('draws parametric and polar curves', () => {
    const circle = renderPlotSvg(spec({ expressions: [{ kind: 'parametric', x: 'cos(t)', y: 'sin(t)' }], xDomain: [-2, 2], yDomain: [-2, 2] }), { width: 400 });
    expect(circle.errors).toEqual([]);
    expect(circle.svg).toContain('<polyline');
    const rose = renderPlotSvg(spec({ expressions: [{ kind: 'polar', r: '2*sin(3*theta)' }], xDomain: [-3, 3], yDomain: [-3, 3] }), { width: 400 });
    expect(rose.errors).toEqual([]);
    expect(rose.svg).toContain('<polyline');
  });

  it('breaks the line at asymptotes instead of drawing a vertical stroke across them', () => {
    const { svg } = renderPlotSvg(spec({ expressions: [{ kind: 'linear', fn: 'tan(x)' }], xDomain: [-5, 5], yDomain: [-5, 5] }), { width: 600 });
    expect((svg.match(/<polyline/g) ?? []).length).toBeGreaterThan(2); // several branches
  });

  it('reports a broken expression without losing the good ones', () => {
    const { svg, errors } = renderPlotSvg(
      spec({ expressions: [{ kind: 'linear', fn: 'x^2' }, { kind: 'linear', fn: 'nonsense(' }, { kind: 'linear', fn: 'y' }] }),
      { width: 500 },
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^2:/);
    expect(svg).toContain('<polyline'); // x^2 still drawn
  });

  it('honours an explicit y range and an inverted x range', () => {
    const { svg, errors } = renderPlotSvg(spec({ expressions: [{ kind: 'linear', fn: 'x' }], xDomain: [5, -5], yDomain: [0, 10] }), { width: 400 });
    expect(errors).toEqual([]);
    expect(svg).toContain('<polyline');
  });

  it('can switch the grid off', () => {
    expect(renderPlotSvg(spec({ grid: false }), { width: 400 }).svg).not.toContain('stroke-opacity="0.12"');
    expect(renderPlotSvg(spec({ grid: true }), { width: 400 }).svg).toContain('stroke-opacity="0.12"');
  });

  it('copes with an expression that is undefined everywhere', () => {
    const { svg, errors } = renderPlotSvg(spec({ expressions: [{ kind: 'linear', fn: 'sqrt(-1 - x^2)' }] }), { width: 400 });
    expect(errors).toEqual([]);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('NaN');
  });
});

describe('niceStep', () => {
  it('picks 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(100, 10)).toBe(10);
    expect(niceStep(7, 7)).toBe(1);
    expect(niceStep(0.5, 5)).toBe(0.1);
  });
});
