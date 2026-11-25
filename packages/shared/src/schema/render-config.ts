import type { ChartData, ChartOptions, ChartType } from './specs';

/** Series colours used when the author did not pick one. Chosen to stay distinguishable in print and dark mode. */
export const SERIES_PALETTE = ['#3b5bdb', '#e8590c', '#2f9e44', '#ae3ec9', '#f08c00', '#1098ad', '#e03131', '#5c7cfa'] as const;

const isCircular = (t: ChartType) => t === 'pie' || t === 'doughnut';

/**
 * Builds a Chart.js configuration from a stored chart block. Pure data, so the editor's live
 * preview and the PDF renderer draw exactly the same chart. (Typed loosely on purpose: this
 * package does not depend on chart.js.)
 */
export function chartJsConfig(
  type: ChartType,
  data: ChartData,
  options: ChartOptions,
  render: { animate: boolean; devicePixelRatio?: number } = { animate: false },
) {
  const datasets = data.datasets.map((d, i) => {
    const color = d.color ?? SERIES_PALETTE[i % SERIES_PALETTE.length]!;
    // The editor's grid stores one number per label. A scatter chart needs (x, y): the label is x.
    const points =
      type === 'scatter'
        ? d.data.map((v, j) => (typeof v === 'number' ? { x: Number.isFinite(Number(data.labels[j])) ? Number(data.labels[j]) : j, y: v } : v))
        : d.data;
    return {
      label: d.label,
      data: points,
      // Pie/doughnut colour each slice; everything else colours the series.
      backgroundColor: isCircular(type) ? data.labels.map((_, j) => SERIES_PALETTE[j % SERIES_PALETTE.length]!) : color,
      borderColor: isCircular(type) ? '#ffffff' : color,
      borderWidth: type === 'bar' ? 0 : 2,
      ...(type === 'line' || type === 'radar' ? { fill: false, tension: 0.25, pointRadius: 3 } : {}),
      ...(type === 'scatter' ? { pointRadius: 4 } : {}),
    };
  });

  const axisTitle = (text?: string) => ({ display: !!text, text: text ?? '' });
  const scales = isCircular(type) || type === 'radar'
    ? undefined
    : {
        x: { stacked: !!options.stacked, title: axisTitle(options.xLabel) },
        y: { stacked: !!options.stacked, beginAtZero: type === 'bar', title: axisTitle(options.yLabel) },
      };

  return {
    type,
    data: { labels: data.labels, datasets },
    options: {
      animation: render.animate ? undefined : (false as const),
      responsive: false,
      maintainAspectRatio: false,
      devicePixelRatio: render.devicePixelRatio ?? 2,
      plugins: {
        title: { display: !!options.title, text: options.title ?? '' },
        legend: { display: options.legend !== false && (datasets.length > 1 || isCircular(type)) },
      },
      ...(scales ? { scales } : {}),
    },
  };
}
