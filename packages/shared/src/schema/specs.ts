import { z } from 'zod';

/** Hard limits applied to every stored document. Shared so the editor can enforce them too. */
export const LIMITS = {
  nameMax: 120,
  titleMax: 200,
  docMaxBytes: 5 * 1024 * 1024,
  docMaxDepth: 40,
  captionMax: 1000,
  altMax: 500,
  mermaidMax: 20_000,
  chartMaxLabels: 500,
  chartMaxDatasets: 12,
  plotMaxExpressions: 10,
  expressionMax: 200,
} as const;

export const MEDIA_ID = z.uuid();

/** Only plain CSS colours: hex, rgb()/hsl() with numeric args, or a colour keyword. */
export const cssColorSchema = z
  .string()
  .max(40)
  .regex(
    /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/a-z]+\)|[a-zA-Z]{3,24})$/,
    'invalid colour',
  );

// ---------------------------------------------------------------- chart

export const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const chartDatasetSchema = z.object({
  label: z.string().max(120).default(''),
  /** Numbers for most charts; {x,y} points for scatter. */
  data: z.array(z.union([z.number(), z.object({ x: z.number(), y: z.number() })])).max(500),
  color: cssColorSchema.nullish(),
});

export const chartDataSchema = z.object({
  labels: z.array(z.string().max(120)).max(LIMITS.chartMaxLabels),
  datasets: z.array(chartDatasetSchema).max(LIMITS.chartMaxDatasets),
});

export const chartOptionsSchema = z.object({
  title: z.string().max(200).optional(),
  legend: z.boolean().optional(),
  stacked: z.boolean().optional(),
  xLabel: z.string().max(120).optional(),
  yLabel: z.string().max(120).optional(),
});

export type ChartData = z.infer<typeof chartDataSchema>;
export type ChartOptions = z.infer<typeof chartOptionsSchema>;

export const DEFAULT_CHART_DATA: ChartData = {
  labels: ['A', 'B', 'C'],
  datasets: [{ label: 'Series 1', data: [3, 5, 2] }],
};

// ---------------------------------------------------------------- function plot

/** Characters a plot expression may contain. Blocks anything beyond arithmetic and function calls. */
const expressionString = z
  .string()
  .min(1)
  .max(LIMITS.expressionMax)
  .regex(/^[\w\s+\-*/^().,]+$/, 'invalid characters in expression')
  // The plot evaluator resolves bare names against an object; `__proto__` and friends are not math.
  .refine((s) => !s.includes('__'), 'invalid expression');

export const plotExpressionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linear'), fn: expressionString, color: cssColorSchema.nullish() }),
  z.object({
    kind: z.literal('parametric'),
    x: expressionString,
    y: expressionString,
    color: cssColorSchema.nullish(),
  }),
  z.object({ kind: z.literal('polar'), r: expressionString, color: cssColorSchema.nullish() }),
]);

export const plotSpecSchema = z.object({
  expressions: z.array(plotExpressionSchema).min(1).max(LIMITS.plotMaxExpressions),
  xDomain: z.tuple([z.number(), z.number()]),
  yDomain: z.tuple([z.number(), z.number()]).nullable(),
  grid: z.boolean(),
  title: z.string().max(200).optional(),
});

export type PlotExpression = z.infer<typeof plotExpressionSchema>;
export type PlotSpec = z.infer<typeof plotSpecSchema>;

export const DEFAULT_PLOT_SPEC: PlotSpec = {
  expressions: [{ kind: 'linear', fn: 'sin(x)' }],
  xDomain: [-10, 10],
  yDomain: null,
  grid: true,
};

// ---------------------------------------------------------------- simple enums

export const CALLOUT_VARIANTS = ['info', 'tip', 'warning', 'danger'] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

export const IMAGE_ALIGNS = ['left', 'center', 'right'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];
