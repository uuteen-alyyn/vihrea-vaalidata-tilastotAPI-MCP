/**
 * Unit tests for the PxWeb variable resolver, against REAL captured metadata.
 *
 * Fixtures are live responses, not inventions — see __fixtures__/README.md.
 * Every fact asserted here was measured across all 91 active tables on
 * 27.08.2026; these tests pin the ones the resolver depends on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findVariable,
  requireVariable,
  findYearVariable,
  findMeasureVariable,
  findMeasureCodesByText,
  resolveContentCode,
  requireContentCode,
  resolvePartySchema,
  findYearColumn,
  VariableResolutionError,
  ContentCodeAmbiguityError,
  AREA_HINTS,
  GENDER_HINTS,
  CANDIDATE_HINTS,
} from './variable-resolver.js';
import type { PxWebTableMetadata } from './types.js';
import type { PartyTableSchema } from '../data/election-tables.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): PxWebTableMetadata =>
  JSON.parse(readFileSync(join(here, '__fixtures__', name), 'utf8'));

const parliamentary = load('metadata-13sw-parliamentary.json');
const municipal     = load('metadata-14z7-municipal.json');
const mixed         = load('metadata-13t2-mixed-codes.json');
const background    = load('metadata-13su-background.json');
const archive       = load('metadata-2019-archive.json');

const ALL: Array<[string, PxWebTableMetadata]> = [
  ['13sw', parliamentary], ['14z7', municipal], ['13t2', mixed],
  ['13su', background], ['2019 archive', archive],
];

describe('the invariant the resolver rests on', () => {
  it.each(ALL)('%s: no two variables share a text', (_name, metadata) => {
    const texts = metadata.variables.map((v) => v.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('post-migration tables (versioned machine codes)', () => {
  it('resolves the declared names to the codes the table actually uses', () => {
    expect(findVariable(parliamentary, ['Puolue'])!.code).toBe('puolue_19_20230101');
    expect(findVariable(parliamentary, AREA_HINTS)!.code).toBe('kunta_109_20230101');
    expect(findVariable(parliamentary, GENDER_HINTS)!.code).toBe('sukupuoli_9_20180101');
  });

  it('finds the time variable by its stable code', () => {
    expect(findYearVariable(parliamentary)!.code).toBe('timeperiod_y');
    expect(findYearVariable(municipal)!.code).toBe('timeperiod_y');
  });

  it('finds the measure variable by its stable code', () => {
    expect(findMeasureVariable(parliamentary)!.code).toBe('contentscode');
    expect(findMeasureVariable(municipal)!.code).toBe('contentscode');
  });
});

describe('the un-migrated archive still resolves through the same path', () => {
  it('matches old-style codes, where code and text are identical', () => {
    expect(findVariable(archive, ['Puolue'])!.code).toBe('Puolue');
    expect(findVariable(archive, AREA_HINTS)!.code).toBe('Äänestysalue');
    expect(findVariable(archive, GENDER_HINTS)!.code).toBe('Sukupuoli');
  });

  it('finds the measure variable, which here is a dimension named differently', () => {
    expect(findMeasureVariable(archive)!.code).toBe('Puolueiden kannatus');
  });

  it('resolves the Sar-style measure values', () => {
    const measure = findMeasureVariable(archive);
    expect(resolveContentCode(measure, 'Sar1')).toBe('Sar1');
  });
});

describe('the migration was not uniform', () => {
  it('13t2 keeps an old-style area code beside versioned ones', () => {
    expect(findVariable(mixed, AREA_HINTS)!.code).toBe('Alue/Äänestysalue');
    expect(findVariable(mixed, ['Puolue'])!.code).toBe('puolue_4_20230303');
  });

  it('an exact code match beats a text match on an earlier hint', () => {
    // AREA_HINTS lists 'Alue/Äänestysalue' first as a code; had text won,
    // resolution order would be silently different for mixed tables.
    expect(findVariable(mixed, ['Alue', 'Alue/Äänestysalue'])!.code).toBe('Alue/Äänestysalue');
  });
});

describe('content codes', () => {
  it('passes through when the code is unchanged', () => {
    const measure = findMeasureVariable(parliamentary);
    expect(resolveContentCode(measure, 'evaa_aanet')).toBe('evaa_aanet');
  });

  it('matches the re-prefixed municipal codes by suffix', () => {
    const measure = findMeasureVariable(municipal);
    expect(resolveContentCode(measure, 'aanet_yht')).toBe('kvaa-aanet_yht');
    expect(resolveContentCode(measure, 'osuus_aanista')).toBe('kvaa-osuus_aanista');
  });

  it('does not confuse pros with pros_sp', () => {
    // 13su offers evaa-lkm1, evaa-pros_sp and evaa-pros. A looser 'contains'
    // match would pick two, and silently reading the wrong measure is worse
    // than failing.
    const measure = findMeasureVariable(background);
    expect(resolveContentCode(measure, 'lkm1')).toBe('evaa-lkm1');
    expect(resolveContentCode(measure, 'pros')).toBe('evaa-pros');
  });

  it('throws rather than guessing when a suffix matches several codes', () => {
    const ambiguous = {
      code: 'contentscode', text: 'Tiedot',
      values: ['kvaa-aanet', 'evaa-aanet'], valueTexts: ['a', 'b'],
    };
    expect(() => resolveContentCode(ambiguous, 'aanet', '14z7')).toThrow(ContentCodeAmbiguityError);
  });

  it('requireContentCode names what was available when it fails', () => {
    const measure = findMeasureVariable(municipal);
    expect(() => requireContentCode(measure, 'no_such_measure', '14z7'))
      .toThrow(/no_such_measure.*not found.*kvaa-aanet_yht/s);
  });
});

describe('schema resolution', () => {
  const municipalSchema: PartyTableSchema = {
    area_var: 'Alue', party_var: 'Puolue', measure_var: 'Tiedot',
    votes_code: 'aanet_yht', share_code: 'osuus_aanista',
    party_total_code: 'SSS', area_code_format: 'six_digit',
    national_code: 'SSS', aggregate_area_level: 'vaalipiiri',
  };

  it('rewrites every field to the live code', () => {
    const resolved = resolvePartySchema(municipal, municipalSchema, '14z7');
    expect(resolved.area_var).toBe('kunta_128_20250101');
    expect(resolved.party_var).toBe('puolue_6_20250103');
    expect(resolved.measure_var).toBe('contentscode');
    expect(resolved.votes_code).toBe('kvaa-aanet_yht');
    expect(resolved.share_code).toBe('kvaa-osuus_aanista');
  });

  it('leaves non-code fields untouched', () => {
    const resolved = resolvePartySchema(municipal, municipalSchema, '14z7');
    expect(resolved.national_code).toBe('SSS');
    expect(resolved.area_code_format).toBe('six_digit');
    expect(resolved.party_total_code).toBe('SSS');
  });

  it('fails loudly when a declared gender variable cannot be found', () => {
    // Dropping it would omit the filter, so PxWeb would return male, female AND
    // total, and the normalizer would emit all three — roughly tripling the
    // national vote count instead of erroring.
    const withGender = { ...municipalSchema, gender_var: 'Ei mitään', gender_total_code: 'SSS' };
    expect(() => resolvePartySchema(municipal, withGender, '14z7')).toThrow(VariableResolutionError);
  });
});

describe('failure messages', () => {
  it('name the table, the role, what was tried, and what exists', () => {
    let message = '';
    try {
      requireVariable(parliamentary, ['Ehdokas'], 'candidate', '13sw');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('13sw');
    expect(message).toContain('candidate');
    expect(message).toContain('Ehdokas');
    expect(message).toContain('puolue_19_20230101');   // what the table does offer
    expect(message).toContain('Puolue');               // ...with its text
  });

  it('a drifted variable produces a resolution error, not a silent wrong query', () => {
    expect(() => requireVariable(municipal, CANDIDATE_HINTS, 'candidate', '14z7'))
      .toThrow(VariableResolutionError);
  });
});

describe('response columns', () => {
  it('finds the time column by its structural type, not its name', () => {
    const columns = [
      { code: 'kunta_109_20230101', text: 'Alue', type: 'd' as const },
      { code: 'timeperiod_y', text: 'Vuosi', type: 't' as const },
      { code: 'evaa_aanet', text: 'Äänet', type: 'c' as const },
    ];
    expect(findYearColumn(columns)!.code).toBe('timeperiod_y');
  });

  it('still finds an old-style time column', () => {
    const columns = [
      { code: 'Alue', text: 'Alue', type: 'd' as const },
      { code: 'Vuosi', text: 'Vuosi', type: 't' as const },
    ];
    expect(findYearColumn(columns)!.code).toBe('Vuosi');
  });
});

describe('measure codes from value texts', () => {
  it('picks votes and share out of the parliamentary measure list', () => {
    const { votes, share } = findMeasureCodesByText(findMeasureVariable(parliamentary));
    expect(votes).toBe('evaa_aanet');
    expect(share).toBe('evaa_osuus_aanista');
  });
});
