import { describe, expect, it } from 'vitest';
import {
  formatSalary,
  normalizeCompany,
  normalizeLevel,
  parseHeadcount,
  parseSalary,
  parseStage,
  salarySortKey,
  sizeBucket,
} from '../src/core/skills/jobOpportunities/normalize.ts';

describe('parseSalary', () => {
  const cases: [string, Partial<ReturnType<typeof parseSalary> & object>][] = [
    ['$240k–$290k base + equity', { min: 240_000, max: 290_000, currency: 'USD', period: 'year', basis: 'base' }],
    ['$180-210k base plus equity', { min: 180_000, max: 210_000 }],
    ['$195,000 - $225,000 + equity', { min: 195_000, max: 225_000 }],
    ['$110/hr', { min: 110, max: 110, period: 'hour', annualUsdMin: 228_800 }],
    ['€95k–€115k', { currency: 'EUR', min: 95_000, max: 115_000 }],
    ['OTE $260k', { basis: 'ote', min: 260_000 }],
    ['up to $250k', { min: null, max: 250_000 }],
    ['$200k+ total comp', { min: 200_000, max: null, basis: 'total' }],
    ['180-220 base', { min: 180_000, max: 220_000 }],
    ['£85,000 salary, 401k-style pension', { currency: 'GBP', min: 85_000, max: 85_000 }],
  ];
  for (const [raw, exp] of cases) {
    it(raw, () => expect(parseSalary(raw)).toMatchObject(exp));
  }
  it('rejects text without amounts', () => {
    expect(parseSalary('competitive')).toBeNull();
    expect(parseSalary(null)).toBeNull();
  });
  it('sort key prefers midpoint; unknown sorts last', () => {
    expect(salarySortKey(parseSalary('$100k-$200k'))).toBe(150_000);
    expect(salarySortKey(null)).toBe(-1);
  });
  it('formats compactly', () => {
    expect(formatSalary(parseSalary('$240k–$290k base'))).toBe('$240k–$290k base');
    expect(formatSalary(parseSalary('$110/hr'))).toBe('$110/hr');
  });
});

describe('size / stage / level / company', () => {
  it('headcount', () => {
    expect(parseHeadcount('~180 people')).toBe(180);
    expect(parseHeadcount('about 2,300 employees')).toBe(2300);
    expect(parseHeadcount('team of 70')).toBe(70);
    expect(sizeBucket(180)).toBe('51–200');
    expect(sizeBucket(null)).toBe('Unknown');
  });
  it('stage', () => {
    expect(parseStage('just closed a $60M Series B')).toBe('Series B');
    expect(parseStage('Series F')).toBe('Series D+');
    expect(parseStage('pre-seed')).toBe('Pre-seed');
    expect(parseStage('publicly traded company (NASDAQ: HLFM)')).toBe('Public');
    expect(parseStage('bootstrapped and profitable')).toBe('Bootstrapped');
    expect(parseStage(null)).toBe('Unknown');
  });
  it('level', () => {
    expect(normalizeLevel('Staff ML Engineer').label).toBe('Staff');
    expect(normalizeLevel('Head of Solutions Engineering').label).toBe('Director / Head');
    expect(normalizeLevel('Software Engineer', 'L6').label).toBe('IC6');
  });
  it('company normalization merges suffix variants', () => {
    expect(normalizeCompany('Anthropic, PBC')).toBe('anthropic');
    expect(normalizeCompany('Kestrel Dynamics Inc.')).toBe('kestrel dynamics');
  });
});
