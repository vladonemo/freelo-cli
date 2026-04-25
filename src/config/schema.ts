import { z } from 'zod';

/**
 * Global defaults stored at the top level of the conf store.
 * Writable via `config set output/color/verbose`.
 * `.strict()` so unexpected keys surface as corrupt-config.
 */
export const DefaultsSchema = z
  .object({
    output: z.enum(['auto', 'human', 'json', 'ndjson']).optional(),
    color: z.enum(['auto', 'never', 'always']).optional(),
    verbose: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

export type Defaults = z.infer<typeof DefaultsSchema>;

/**
 * Shape of the on-disk conf store. `.strict()` because we control the writer
 * and unexpected fields on read indicate corruption.
 *
 * schemaVersion 2 adds the top-level `defaults` map.
 * Migrated from v1 by `migrateV1toV2` in store.ts.
 */
export const ConfStoreSchema = z
  .object({
    schemaVersion: z.literal(2),
    currentProfile: z.string().nullable(),
    profiles: z.record(
      z.string(),
      z.object({ email: z.string(), apiBaseUrl: z.string() }).strict(),
    ),
    defaults: DefaultsSchema,
  })
  .strict();

export type ConfStore = z.infer<typeof ConfStoreSchema>;

/**
 * ProfileSource identifies where a resolved config value came from.
 * Extended in R02 with 'rc' for project-level `.freelorc.*` files.
 */
export type ProfileSource = 'flag' | 'env' | 'rc' | 'conf' | 'default';

/**
 * SourceLiteral extends ProfileSource with 'derived' — used only in the
 * `config resolve --show-source` envelope for the `profileSource` field itself
 * (which has no further source to attribute).
 */
export type SourceLiteral = ProfileSource | 'derived';

/**
 * Frozen in-memory configuration assembled by `buildAppConfig` at startup.
 * Commands receive this via closure; they never read process.env directly.
 */
export type AppConfig = Readonly<{
  profile: string;
  profileSource: ProfileSource;
  email: string;
  apiKey: string; // never logged, never in an envelope
  apiBaseUrl: string;
  userAgent: string;
  output: {
    /** After buildPartialAppConfig, mode is always resolved (never 'auto'). */
    mode: 'human' | 'json' | 'ndjson';
    color: 'auto' | 'never' | 'always';
  };
  verbose: 0 | 1 | 2;
  yes: boolean;
  requestId: string; // uuid
}>;

/**
 * Partial config resolved before credentials are available.
 * Used by `buildAppConfig` before `resolveCredentials` is called.
 */
export type PartialAppConfig = Omit<AppConfig, 'email' | 'apiKey'>;

/**
 * A zero-argument function that returns the resolved `PartialAppConfig`.
 * Safe to call only from within a Commander action handler — i.e. after the
 * `preAction` hook in `src/bin/freelo.ts` has fired.
 */
export type GetAppConfig = () => PartialAppConfig;
