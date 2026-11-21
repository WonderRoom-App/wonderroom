import type { CollectionBeforeValidateHook, Field, FieldAccess } from 'payload'
import { parseYear } from './parseYear'

/** Read access for fields that must never reach the public site or API. */
const privateRead: FieldAccess = ({ req }) => Boolean(req.user)

const presenceOptions = [
  { label: 'In collection', value: 'collection' },
  { label: 'Parts item', value: 'parts' },
  { label: 'No longer in collection', value: 'departed' },
]

/**
 * When the sortable Year from (or Month from) is blank, read it out of the
 * free-form Year text. parseYear refuses anything ambiguous, so a date it
 * cannot read stays blank and waits for a person.
 */
export const setYearRangeFromYear: CollectionBeforeValidateHook = ({ data, originalDoc }) => {
  if (!data) return data
  const parsed = parseYear(data.year ?? originalDoc?.year)
  if (!parsed) return data

  if ((data.yearFrom ?? originalDoc?.yearFrom) == null) {
    data.yearFrom = parsed.from
    data.yearTo = parsed.to
  }
  // Months fill on their own, apart from the years.
  if ((data.monthFrom ?? originalDoc?.monthFrom) == null) {
    data.monthFrom = parsed.monthFrom
    data.monthTo = parsed.monthTo
  }
  return data
}

/** The fields every item type has. Item-type plugins add theirs after these. */
export const coreItemFields: Field[] = [
  { name: 'title', type: 'text', required: true },
  {
    name: 'titleHint',
    label: 'Title hint',
    type: 'text',
    admin: {
      description: 'Short public detail to tell near-identical titles apart. Appended to the title.',
    },
  },
  {
    name: 'presence',
    type: 'select',
    options: presenceOptions,
    defaultValue: 'collection',
    required: true,
    index: true,
    admin: { description: 'Where this item stands. Public.' },
  },
  {
    name: 'tags',
    type: 'relationship',
    relationTo: 'tags',
    hasMany: true,
    admin: { description: 'Ad-hoc labels. Type to find or create.' },
  },
  {
    name: 'year',
    type: 'text',
    admin: { description: 'Year or range of manufacture (for example 1930, 1927-1929, "early 1949").' },
  },
  {
    name: 'yearFrom',
    label: 'Year from',
    type: 'number',
    min: 1800,
    max: 2100,
    admin: { description: 'Sortable start year. Year stays the display text.' },
  },
  {
    name: 'yearTo',
    label: 'Year to',
    type: 'number',
    min: 1800,
    max: 2100,
    validate: (value: unknown, { siblingData }: { siblingData: Record<string, unknown> }) => {
      const from = siblingData?.yearFrom
      if (typeof value !== 'number' || typeof from !== 'number') return true
      return value >= from || 'Year to must not be earlier than Year from.'
    },
    admin: { description: 'Only when the date is a range.' },
  },
  {
    name: 'monthFrom',
    label: 'Month from',
    type: 'number',
    min: 1,
    max: 12,
    admin: { description: 'Only when the date is known finer than a year. 1-12, qualifies Year from.' },
  },
  {
    name: 'monthTo',
    label: 'Month to',
    type: 'number',
    min: 1,
    max: 12,
    // A span that crosses a year boundary may end in an earlier month.
    // Compare the months only when both sit inside one year.
    validate: (value: unknown, { siblingData }: { siblingData: Record<string, unknown> }) => {
      const { monthFrom, yearFrom, yearTo } = siblingData ?? {}
      const withinOneYear = yearTo == null || yearTo === yearFrom
      if (!withinOneYear) return true
      if (typeof value !== 'number' || typeof monthFrom !== 'number') return true
      return value >= monthFrom || 'Month to must not be earlier than Month from.'
    },
    admin: { description: 'Qualifies Year to. Same as Month from for a single month.' },
  },
  {
    name: 'dateBasis',
    label: 'Date basis',
    type: 'select',
    options: [
      { label: 'Exact', value: 'exact' },
      { label: 'Interpolated', value: 'interpolated' },
      { label: 'Model production range', value: 'model-range' },
      { label: 'Approximate', value: 'approximate' },
    ],
    admin: {
      description: 'How the year was found. Anything other than Exact shows an estimate marker.',
    },
  },
  {
    name: 'photos',
    type: 'upload',
    relationTo: 'media',
    hasMany: true,
    admin: { description: 'The first photo is the primary image.' },
  },
  { name: 'description', type: 'richText' },
  { name: 'notes', type: 'textarea' },
  {
    name: 'provenance',
    type: 'textarea',
    admin: { description: 'Public origin and where it came from. Keep prices out.' },
  },
  {
    name: 'acquisitionNotes',
    label: 'Acquisition details (price, seller)',
    type: 'textarea',
    access: { read: privateRead },
    admin: { description: 'Price paid and private seller details. Admin only.' },
  },
  {
    name: 'disposition',
    label: 'Disposition (what happened to it)',
    type: 'textarea',
    access: { read: privateRead },
    admin: { description: 'For example "Sold to Jane, 2025". Admin only.' },
  },
  {
    name: 'onLoanTo',
    label: 'On loan to',
    type: 'text',
    access: { read: privateRead },
  },
  {
    name: 'purchaseInterest',
    label: 'Purchase interest',
    type: 'text',
    access: { read: privateRead },
    admin: { description: 'People who have asked to buy it. Admin only.' },
  },
]
