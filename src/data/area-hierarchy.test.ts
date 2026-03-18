import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseKuntaCode,
  getVaalipiiriFromAanestysalueCode,
  getKuntaToVaalipiiri,
  _clearKuntaToVaalipiiriCache,
  VAALIPIIRI_PREFIX_MAP,
} from './area-hierarchy.js';

describe('parseKuntaCode', () => {
  it('extracts kunta code from parliamentary äänestysalue code', () => {
    expect(parseKuntaCode('01091001A', 'parliamentary')).toBe('091'); // Helsinki
  });

  it('extracts kunta code for Tampere', () => {
    expect(parseKuntaCode('06837001A', 'parliamentary')).toBe('837');
  });

  it('works for municipal election type', () => {
    expect(parseKuntaCode('02049001A', 'municipal')).toBe('049'); // Espoo
  });

  it('works for presidential election type', () => {
    expect(parseKuntaCode('01091011D', 'presidential')).toBe('091');
  });

  it('returns null for EU parliament (format unverified)', () => {
    expect(parseKuntaCode('01091001A', 'eu_parliament')).toBeNull();
  });

  it('returns null for regional election type', () => {
    expect(parseKuntaCode('01091001A', 'regional')).toBeNull();
  });

  it('returns null for non-numeric code', () => {
    expect(parseKuntaCode('KU091', 'parliamentary')).toBeNull();
  });

  it('returns null for SSS national code', () => {
    expect(parseKuntaCode('SSS', 'parliamentary')).toBeNull();
  });
});

describe('getVaalipiiriFromAanestysalueCode', () => {
  it('returns helsinki for prefix 01', () => {
    expect(getVaalipiiriFromAanestysalueCode('01091001A')).toBe('helsinki');
  });

  it('returns pirkanmaa for prefix 06', () => {
    expect(getVaalipiiriFromAanestysalueCode('06837001A')).toBe('pirkanmaa');
  });

  it('returns uusimaa for prefix 02', () => {
    expect(getVaalipiiriFromAanestysalueCode('02049001A')).toBe('uusimaa');
  });

  it('returns lappi for prefix 12', () => {
    expect(getVaalipiiriFromAanestysalueCode('12683001A')).toBe('lappi');
  });

  it('returns null for non-numeric prefix', () => {
    expect(getVaalipiiriFromAanestysalueCode('KU091')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(getVaalipiiriFromAanestysalueCode('99091001A')).toBeNull();
  });
});

describe('VAALIPIIRI_PREFIX_MAP', () => {
  it('has all 13 vaalipiiri entries', () => {
    expect(Object.keys(VAALIPIIRI_PREFIX_MAP).length).toBe(13);
  });

  it('maps 01 to helsinki', () => {
    expect(VAALIPIIRI_PREFIX_MAP['01']).toBe('helsinki');
  });

  it('maps 13 to ahvenanmaa', () => {
    expect(VAALIPIIRI_PREFIX_MAP['13']).toBe('ahvenanmaa');
  });
});

describe('getKuntaToVaalipiiri', () => {
  beforeEach(() => {
    _clearKuntaToVaalipiiriCache();
  });

  const makeLoader = (codes: Array<{ code: string; valueText: string }>) =>
    () => Promise.resolve(codes);

  it('maps kunta codes from 6-digit codes', async () => {
    const loader = makeLoader([
      { code: 'SSS',    valueText: 'Koko maa' },
      { code: '010000', valueText: 'Helsingin vaalipiiri' },    // aggregate, skip
      { code: '010910', valueText: 'Helsinki' },                // kunta 091 → helsinki
      { code: '020490', valueText: 'Espoo' },                   // kunta 049 → uusimaa
      { code: '068370', valueText: 'Tampere' },                 // kunta 837 → pirkanmaa
    ]);
    const map = await getKuntaToVaalipiiri(loader);
    expect(map['091']).toBe('helsinki');
    expect(map['049']).toBe('uusimaa');
    expect(map['837']).toBe('pirkanmaa');
  });

  it('skips SSS and aggregate rows ending in 0000', async () => {
    const loader = makeLoader([
      { code: 'SSS',    valueText: 'Koko maa' },
      { code: '010000', valueText: 'Helsingin vaalipiiri' },
      { code: '020000', valueText: 'Uudenmaan vaalipiiri' },
    ]);
    const map = await getKuntaToVaalipiiri(loader);
    expect(Object.keys(map).length).toBe(0);
  });

  it('coalesces concurrent calls into a single fetch', async () => {
    let fetchCount = 0;
    const loader = () => {
      fetchCount++;
      return Promise.resolve([{ code: '010910', valueText: 'Helsinki' }]);
    };
    await Promise.all([
      getKuntaToVaalipiiri(loader),
      getKuntaToVaalipiiri(loader),
      getKuntaToVaalipiiri(loader),
    ]);
    expect(fetchCount).toBe(1);
  });

  it('returns cached result on subsequent calls', async () => {
    let fetchCount = 0;
    const loader = () => {
      fetchCount++;
      return Promise.resolve([{ code: '010910', valueText: 'Helsinki' }]);
    };
    await getKuntaToVaalipiiri(loader);
    await getKuntaToVaalipiiri(loader);
    expect(fetchCount).toBe(1);
  });
});
