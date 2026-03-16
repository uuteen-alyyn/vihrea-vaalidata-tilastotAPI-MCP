import type { DataSource, DataModeResponse, AnalysisModeResponse, ElectionRecord, OutputMode } from '../data/types.js';

export function dataResponse(
  rows: ElectionRecord[],
  source: DataSource
): DataModeResponse {
  return { mode: 'data', rows, source };
}

export function analysisResponse(
  summary: Record<string, unknown>,
  tables: Record<string, unknown>,
  method: Record<string, unknown>,
  source: DataSource
): AnalysisModeResponse {
  return { mode: 'analysis', summary, tables, method, source };
}

export function parseOutputMode(input: unknown): OutputMode {
  return input === 'analysis' ? 'analysis' : 'data';
}
