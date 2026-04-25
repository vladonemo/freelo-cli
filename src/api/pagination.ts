import { type ZodSchema } from 'zod';
import { type Paging } from '../ui/envelope.js';
import { ValidationError } from '../errors/validation-error.js';
import { FreeloApiError } from '../errors/freelo-api-error.js';
import { paginatedProjectsWrapperSchema } from './schemas/project.js';

/**
 * Internal normalized shape; never serialized to envelope directly.
 * Matches spec 0009 §4.1.
 */
export type NormalizedPage<T> = {
  data: T[];
  /** 0-indexed, mirroring Freelo's wire format. */
  page: number;
  perPage: number;
  total: number;
  /** null on last page or unpaginated endpoints. */
  nextCursor: number | null;
};

/** Build the envelope `paging` field from a NormalizedPage. */
export function pagingFromNormalized<T>(p: NormalizedPage<T>): Paging {
  return {
    page: p.page,
    per_page: p.perPage,
    total: p.total,
    next_cursor: p.nextCursor,
  };
}

/**
 * For the `/projects` bare-array case: synthesize a single-page NormalizedPage
 * (spec §4.1 — uniform envelope shape across all five scopes).
 */
export function synthesizeUnpaginated<T>(items: T[]): NormalizedPage<T> {
  return {
    data: items,
    page: 0,
    perPage: items.length,
    total: items.length,
    nextCursor: null,
  };
}

/**
 * Validate a paginated response body and extract the inner array, returning
 * a NormalizedPage. The wire shape's `data` object holds `{ [innerKey]: T[] }`.
 * Computes `nextCursor` as `(page+1) * per_page < total ? page + 1 : null`.
 */
export function normalizePaginated<T>(
  raw: unknown,
  innerKey: string,
  itemSchema: ZodSchema<T>,
): NormalizedPage<T> {
  const wrapperSchema = paginatedProjectsWrapperSchema(innerKey, itemSchema);
  const parsed = wrapperSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FreeloApiError(
      `Unexpected paginated response shape (key '${innerKey}'): ${parsed.error.message}`,
      'VALIDATION_ERROR',
      { rawBody: raw },
    );
  }
  const wrapper = parsed.data;
  const items = wrapper.data[innerKey] ?? [];
  const lastIndex = (wrapper.page + 1) * wrapper.per_page;
  const nextCursor = lastIndex < wrapper.total ? wrapper.page + 1 : null;
  return {
    data: items,
    page: wrapper.page,
    perPage: wrapper.per_page,
    total: wrapper.total,
    nextCursor,
  };
}

/**
 * Thrown by `fetchAllPages` when iteration aborts mid-stream after at least
 * one successful page. The command layer catches this to emit the partial
 * envelope to stdout before re-throwing the underlying cause.
 */
export class PartialPagesError<T> extends Error {
  override readonly name = 'PartialPagesError';
  readonly accumulated: NormalizedPage<T>;
  /** The page index the failure occurred on (the page we tried to fetch). */
  readonly failedPage: number;
  readonly innerCause: unknown;

  constructor(opts: { accumulated: NormalizedPage<T>; failedPage: number; cause: unknown }) {
    const causeMessage = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    super(`Partial pages: aborted at page ${opts.failedPage} (${causeMessage})`);
    this.accumulated = opts.accumulated;
    this.failedPage = opts.failedPage;
    this.innerCause = opts.cause;
  }
}

export type FetchAllPagesOptions<T> = {
  fetchPage: (p: number) => Promise<NormalizedPage<T>>;
  signal?: AbortSignal;
  /** Called after each successful page (used by ndjson streaming). */
  onPage?: (page: NormalizedPage<T>) => void;
};

/**
 * Iterate `?p=0, 1, ...` until `nextCursor === null`. On thrown error mid-
 * iteration after at least one successful page, throws `PartialPagesError`
 * carrying the accumulated data plus the failed page index. On error before
 * any successful page, the underlying error is re-thrown unchanged.
 */
export async function fetchAllPages<T>(opts: FetchAllPagesOptions<T>): Promise<NormalizedPage<T>> {
  const accumulated: T[] = [];
  let cursor = 0;
  let lastPage: NormalizedPage<T> | undefined;

  while (true) {
    if (opts.signal?.aborted === true) {
      // Abort surfaces the same way as fetch's AbortError — let the top-level
      // handler treat it as a SIGINT exit. Wrap as PartialPagesError if we have
      // pages so the command can emit them.
      const err = new Error('Aborted');
      err.name = 'AbortError';
      if (lastPage !== undefined) {
        throw new PartialPagesError<T>({
          accumulated: {
            data: accumulated,
            page: lastPage.page,
            perPage: lastPage.perPage,
            total: lastPage.total,
            nextCursor: lastPage.nextCursor,
          },
          failedPage: cursor,
          cause: err,
        });
      }
      throw err;
    }

    let page: NormalizedPage<T>;
    try {
      page = await opts.fetchPage(cursor);
    } catch (err) {
      if (lastPage !== undefined) {
        throw new PartialPagesError<T>({
          accumulated: {
            data: accumulated,
            page: lastPage.page,
            perPage: lastPage.perPage,
            total: lastPage.total,
            nextCursor: cursor,
          },
          failedPage: cursor,
          cause: err,
        });
      }
      throw err;
    }

    accumulated.push(...page.data);
    lastPage = page;
    opts.onPage?.(page);

    if (page.nextCursor === null) {
      return {
        data: accumulated,
        page: page.page,
        perPage: page.perPage,
        total: page.total,
        nextCursor: null,
      };
    }
    cursor = page.nextCursor;
  }
}

/**
 * Project an array of records to the listed top-level fields (spec §4.5).
 * Validates `fields` against `knownFields` before any HTTP call; throws
 * ValidationError with the spec's exact `hintNext` strings.
 *
 * - Empty `fields` → EMPTY_FIELDS.
 * - Any name containing `.` → NESTED_FIELDS_UNSUPPORTED.
 * - Any name not in `knownFields` → UNKNOWN_FIELD (lists the valid set).
 *
 * Records that lack a requested field have it absent in the output (not
 * `null` — so JSON serialization stays compact).
 */
export function projectFields<T extends Record<string, unknown>>(
  records: readonly T[],
  fields: readonly string[],
  knownFields: readonly string[],
  scopeForMessage: string,
): Partial<T>[] {
  if (fields.length === 0) {
    throw new ValidationError('Specify at least one field, or omit --fields for the default set.', {
      hintNext: 'Specify at least one field, or omit --fields for the default set.',
    });
  }
  for (const f of fields) {
    if (f.includes('.')) {
      throw new ValidationError(`Nested field projection is not supported in v1 ('${f}').`, {
        hintNext: 'Use top-level field names only (e.g. --fields id,name,state).',
      });
    }
    if (!knownFields.includes(f)) {
      throw new ValidationError(
        `Unknown field '${f}' for scope '${scopeForMessage}'. Valid fields: ${knownFields.join(
          ', ',
        )}.`,
        {
          hintNext:
            "Run 'freelo projects list --output json' once to see the full envelope, or check 'freelo --introspect'.",
        },
      );
    }
  }
  return records.map((rec) => {
    const out: Partial<T> = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(rec, f)) {
        (out as Record<string, unknown>)[f] = rec[f];
      }
    }
    return out;
  });
}
