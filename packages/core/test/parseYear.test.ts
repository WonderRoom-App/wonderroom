import { describe, expect, it } from 'vitest'

import { setYearRangeFromYear } from '../src/coreFields'
import { parseYear } from '../src/parseYear'

// Every case below is a real year string in the shapes the catalog uses, so this test is
// an inventory of what the data looks like -- not a set of shapes we imagined.
describe('parseYear', () => {
  it('reads a plain year as a single year, not a range', () => {
    expect(parseYear('1930')).toEqual({ from: 1930, to: null, monthFrom: null, monthTo: null })
    expect(parseYear('1883')).toEqual({ from: 1883, to: null, monthFrom: null, monthTo: null })
  })

  it('reads a full range', () => {
    expect(parseYear('1927-1929')).toEqual({ from: 1927, to: 1929, monthFrom: null, monthTo: null })
    expect(parseYear('1909-1914')).toEqual({ from: 1909, to: 1914, monthFrom: null, monthTo: null })
    expect(parseYear('1927-1949')).toEqual({ from: 1927, to: 1949, monthFrom: null, monthTo: null })
  })

  it('reads a two-digit end year against the century of the start', () => {
    expect(parseYear('1911-12')).toEqual({ from: 1911, to: 1912, monthFrom: null, monthTo: null })
  })

  it('ignores a within-the-year qualifier', () => {
    expect(parseYear('early 1949')).toEqual({ from: 1949, to: null, monthFrom: 1, monthTo: 4 })
    expect(parseYear('late 1909')).toEqual({ from: 1909, to: null, monthFrom: 9, monthTo: 12 })
    expect(parseYear('Late 1937')).toEqual({ from: 1937, to: null, monthFrom: 9, monthTo: 12 })
    expect(parseYear('early-mid 1903')).toEqual({ from: 1903, to: null, monthFrom: 1, monthTo: 8 })
    expect(parseYear('mid-late 1946')).toEqual({ from: 1946, to: null, monthFrom: 5, monthTo: 12 })
    expect(parseYear('late 1921')).toEqual({ from: 1921, to: null, monthFrom: 9, monthTo: 12 })
  })

  it('reads a qualified range', () => {
    expect(parseYear('late 1915 - early 1916')).toEqual({ from: 1915, to: 1916, monthFrom: 9, monthTo: 4 })
  })

  it('ignores months', () => {
    expect(parseYear('9/1898 - 12/1900')).toEqual({ from: 1898, to: 1900, monthFrom: 9, monthTo: 12 })
  })

  it('reads an open-ended year as a single year', () => {
    expect(parseYear('1984+')).toEqual({ from: 1984, to: null, monthFrom: null, monthTo: null })
  })

  it('reads "or" as the range it spans', () => {
    expect(parseYear('1907 or 1908')).toEqual({ from: 1907, to: 1908, monthFrom: null, monthTo: null })
  })

  // Months qualify each ENDPOINT of the span, which is what lets a sub-year claim run
  // across a year boundary and a model range carry its own start and end months.
  describe('months', () => {
    it('reads a named month', () => {
      expect(parseYear('Dec 1925')).toEqual({ from: 1925, to: null, monthFrom: 12, monthTo: 12 })
      expect(parseYear('July 1919')).toEqual({ from: 1919, to: null, monthFrom: 7, monthTo: 7 })
      expect(parseYear('Sept 1930')).toEqual({ from: 1930, to: null, monthFrom: 9, monthTo: 9 })
    })

    it('reads a set of months, as a serial-number database reports them', () => {
      expect(parseYear('Jan-Mar 1904')).toEqual({ from: 1904, to: null, monthFrom: 1, monthTo: 3 })
      expect(parseYear('Feb - Nov 1926')).toEqual({
        from: 1926,
        to: null,
        monthFrom: 2,
        monthTo: 11,
      })
    })

    it('reads early/mid/late as thirds of the year', () => {
      expect(parseYear('early 1949')?.monthFrom).toEqual(1)
      expect(parseYear('early 1949')?.monthTo).toEqual(4)
      expect(parseYear('mid 1949')?.monthFrom).toEqual(5)
      expect(parseYear('late 1949')?.monthTo).toEqual(12)
    })

    it('spans compound thirds with no gap between them', () => {
      expect(parseYear('early-mid 1903')?.monthTo).toEqual(8)
      expect(parseYear('mid-late 1946')?.monthFrom).toEqual(5)
    })

    it('attaches each month to the year it precedes', () => {
      // Sep of 1915 through Apr of 1916 — the months belong to different years, so a
      // monthTo lower than monthFrom is correct, not a backwards range.
      expect(parseYear('late 1915 - early 1916')).toEqual({
        from: 1915,
        to: 1916,
        monthFrom: 9,
        monthTo: 4,
      })
      expect(parseYear('9/1898 - 12/1900')).toEqual({
        from: 1898,
        to: 1900,
        monthFrom: 9,
        monthTo: 12,
      })
    })

    it('leaves months null when the text says only a year', () => {
      expect(parseYear('1930')?.monthFrom).toEqual(null)
      expect(parseYear('1927-1929')?.monthTo).toEqual(null)
    })

    it('is not fooled by words that merely start like a month', () => {
      // "probably" ends in no month; "Junior" is not June.
      expect(parseYear('probably 1919')?.monthFrom).toBeNull()
      expect(parseYear('Junior 1914')?.monthFrom).toBeNull()
    })
  })

  // The refusals. Each of these carries a second claim about the item, and
  // choosing between them is a person's job.
  it('refuses text holding a competing claim', () => {
    expect(parseYear('1906, 1890')).toBeNull()
    expect(parseYear('1913-1918, likely later')).toBeNull()
    expect(parseYear('1915, probably 1919-1921')).toBeNull()
  })

  it('refuses empty and yearless text', () => {
    expect(parseYear(null)).toBeNull()
    expect(parseYear('')).toBeNull()
    expect(parseYear('unknown')).toBeNull()
  })

  it('refuses a backwards range rather than silently swapping it', () => {
    expect(parseYear('1930-1920')).toBeNull()
  })
})

describe('setYearRangeFromYear', () => {
  const run = (data: Record<string, unknown>) =>
    (setYearRangeFromYear as (args: unknown) => Record<string, unknown>)({ data, originalDoc: undefined })

  it('fills the year and month range from the year text', () => {
    expect(run({ year: 'early 1949' })).toMatchObject({ yearFrom: 1949, monthFrom: 1, monthTo: 4 })
  })

  it('leaves an already-set yearFrom unchanged', () => {
    expect(run({ year: 'early 1949', yearFrom: 1950 }).yearFrom).toBe(1950)
  })
})
