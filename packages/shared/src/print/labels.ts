import type { Locale } from '../dto/common';

export interface PrintLabels {
  toc: string;
  untitled: string;
  generated: (date: string) => string;
  video: string;
  notebook: string;
  category: string;
  page: string;
}

export const PRINT_LABELS: Record<Locale, PrintLabels> = {
  en: {
    toc: 'Contents',
    untitled: 'Untitled',
    generated: (d) => `Exported on ${d}`,
    video: 'Video',
    notebook: 'Notebook',
    category: 'Category',
    page: 'Page',
  },
  pt: {
    toc: 'Índice',
    untitled: 'Sem título',
    generated: (d) => `Exportado em ${d}`,
    video: 'Vídeo',
    notebook: 'Caderno',
    category: 'Categoria',
    page: 'Página',
  },
};

export const formatPrintDate = (date: Date, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === 'pt' ? 'pt-PT' : 'en-GB', { dateStyle: 'long' }).format(date);
