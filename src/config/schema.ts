import { z } from 'zod';

/**
 * Shape of the on-disk conf store. `.strict()` because we control the writer
 * and unexpected fields on read indicate corruption.
 */
export const ConfStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    currentProfile: z.string().nullable(),
    profiles: z.record(
      z.string(),
      z.object({ email: z.string(), apiBaseUrl: z.string() }).strict(),
    ),
  })
  .strict();

export type ConfStore = z.infer<typeof ConfStoreSchema>;

export type ProfileSource = 'flag' | 'env' | 'conf' | 'default';

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
