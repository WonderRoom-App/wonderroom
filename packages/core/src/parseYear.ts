// Parse the free-form `year` text into the sortable yearFrom/yearTo pair, plus the
// month qualifiers when the text says something finer than a year.
//
// The free-form field stays the display string ("early 1949", "9/1898 - 12/1900").
// These numbers exist only to order and position items. So this parser is
// deliberately narrow: it reads the shapes the catalog actually uses, and returns
// null for anything it cannot read rather than guessing. A null is a prompt for a
// human, not a failure.

export interface YearRange {
  from: number
  to: number | null // null = a single year, not a range
  /** Month (1-12) qualifying `from`. Null when the text says nothing finer. */
  monthFrom: number | null
  /** Month (1-12) qualifying `to` (or `from`, when there is no range). */
  monthTo: number | null
}

// Every spelling that counts as a month, listed in full rather than matched on a
// prefix. "Junior" starts with "jun" and is not June; "March" the month and "Marchant"
// the maker differ only after the third letter.
const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

// "Early", "mid" and "late" are month ranges written in words. Thirds, not quarters, so
// they tile the year with no gaps between them -- which is what lets the compound forms
// ("early-mid", "mid-late") simply span from one third's start to another's end.
const THIRDS: Record<string, [number, number]> = {
  early: [1, 4],
  mid: [5, 8],
  late: [9, 12],
}

/**
 * Read the months out of the words immediately before a year.
 *
 * Only the text between the previous year and this one is considered, so the month in
 * "9/1898 - 12/1900" attaches to the year it precedes and not to the other.
 */
function monthsBefore(prefix: string): [number, number] | null {
  const text = prefix.toLowerCase().trimEnd()

  // "9/1898" -- a numeric month glued to its year.
  const numeric = text.match(/(\d{1,2})\s*\/\s*$/)
  if (numeric) {
    const month = Number(numeric[1])
    return month >= 1 && month <= 12 ? [month, month] : null
  }

  // "early 1949", "mid-late 1946" -- a third of the year, or a span of thirds.
  const thirds = text.match(/\b(early|mid|late)(?:\s*-\s*(early|mid|late))?[\s-]*$/)
  if (thirds) {
    const start = THIRDS[thirds[1]]
    const end = THIRDS[thirds[2] ?? thirds[1]]
    return [start[0], end[1]]
  }

  // "Jan-Mar 1904" -- a set of months, which is how a serial-number database often
  // reports an interpolation. Checked before the single-month form below, which
  // would otherwise read only the second name.
  const pair = text.match(/\b([a-z]{3,9})\.?\s*[-\u2013]\s*([a-z]{3,9})\.?\s*$/)
  if (pair) {
    const start = MONTHS[pair[1]]
    const end = MONTHS[pair[2]]
    if (start && end) return [start, end]
  }

  // "Dec 1925", "July 1919" -- a named month, in any spelling MONTHS lists.
  const named = text.match(/\b([a-z]{3,9})\.?\s*$/)
  if (named) {
    const month = MONTHS[named[1]]
    if (month) return [month, month]
  }

  return null
}

export function parseYear(text: string | null | undefined): YearRange | null {
  if (!text) return null

  // A comma introduces a second, competing claim -- "1906, 1890",
  // "1915, probably 1919-1921", "1913-1918, likely later". Which year wins is a
  // judgement about the item, not about the text, so never guess it.
  if (text.includes(',')) return null

  const matches = [...text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)]
  if (matches.length === 0) return null

  const years = matches.map((m) => Number(m[1]))
  const from = years[0]

  // "1911-12" -- a range whose end year is written with two digits, so it never
  // matches as a year on its own. Read it against the century of the start year.
  const shortEnd = years.length === 1 ? text.match(/\b\d{4}\s*[-–]\s*(\d{2})\b/) : null
  const to = shortEnd
    ? Math.floor(from / 100) * 100 + Number(shortEnd[1])
    : years.length > 1
      ? years[years.length - 1]
      : null

  // A range that runs backwards is a typo, not a date. Leave it for a human.
  if (to !== null && to < from) return null

  // Months qualify the ENDPOINTS: the first year's month opens the span, the last
  // year's month closes it. On a single year both come from the same words, so
  // "early 1949" opens in January and closes in April.
  const first = matches[0]
  const last = matches[matches.length - 1]
  const firstMonths = monthsBefore(text.slice(0, first.index))
  const lastMonths =
    last === first ? firstMonths : monthsBefore(text.slice(first.index + first[0].length, last.index))

  return {
    from,
    to,
    monthFrom: firstMonths?.[0] ?? null,
    monthTo: lastMonths?.[1] ?? null,
  }
}
