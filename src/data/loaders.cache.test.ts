import { describe, it, expect } from 'vitest';
import { filterResponseByYear } from './loaders.js';
import type { PxWebResponse } from '../api/types.js';

// ── filterResponseByYear ───────────────────────────────────────────────────────

describe('filterResponseByYear', () => {
  const multiYearResponse: PxWebResponse = {
    columns: [
      { code: 'Vuosi',  text: 'Year',  type: 't' },
      { code: 'Alue',   text: 'Area',  type: 'd' },
      { code: 'Puolue', text: 'Party', type: 'd' },
      { code: 'aanet',  text: 'Votes', type: 'c' },
    ],
    data: [
      { key: ['2019', 'SSS', 'KOK'], values: ['100000'] },
      { key: ['2019', 'SSS', 'SDP'], values: ['90000']  },
      { key: ['2023', 'SSS', 'KOK'], values: ['120000'] },
      { key: ['2023', 'SSS', 'SDP'], values: ['95000']  },
      { key: ['2015', 'SSS', 'KOK'], values: ['110000'] },
    ],
  };

  it('keeps only rows for the requested year', () => {
    const result = filterResponseByYear(multiYearResponse, 2023);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.key[0] === '2023')).toBe(true);
  });

  it('returns rows for a different year correctly', () => {
    const result = filterResponseByYear(multiYearResponse, 2015);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.key[0]).toBe('2015');
  });

  it('returns empty data when year has no rows', () => {
    const result = filterResponseByYear(multiYearResponse, 2011);
    expect(result.data).toHaveLength(0);
  });

  it('preserves columns unchanged', () => {
    const result = filterResponseByYear(multiYearResponse, 2023);
    expect(result.columns).toBe(multiYearResponse.columns);
  });

  it('returns response unchanged when no Vuosi column is present', () => {
    const noVuosi: PxWebResponse = {
      columns: [
        { code: 'Alue',   text: 'Area',  type: 'd' },
        { code: 'Puolue', text: 'Party', type: 'd' },
        { code: 'aanet',  text: 'Votes', type: 'c' },
      ],
      data: [
        { key: ['SSS', 'KOK'], values: ['100000'] },
      ],
    };
    const result = filterResponseByYear(noVuosi, 2023);
    expect(result).toBe(noVuosi);
  });

  it('works when Vuosi is not the first key column', () => {
    const vuosiLast: PxWebResponse = {
      columns: [
        { code: 'Alue',   text: 'Area',  type: 'd' },
        { code: 'Puolue', text: 'Party', type: 'd' },
        { code: 'Vuosi',  text: 'Year',  type: 't' },
        { code: 'aanet',  text: 'Votes', type: 'c' },
      ],
      data: [
        { key: ['SSS', 'KOK', '2019'], values: ['100000'] },
        { key: ['SSS', 'KOK', '2023'], values: ['120000'] },
        { key: ['SSS', 'SDP', '2019'], values: ['90000']  },
        { key: ['SSS', 'SDP', '2023'], values: ['95000']  },
      ],
    };
    const result = filterResponseByYear(vuosiLast, 2023);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.key[2] === '2023')).toBe(true);
  });
});
