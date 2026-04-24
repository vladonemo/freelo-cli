// Root of the typed error hierarchy. Every domain-specific error
// (FreeloApiError, ConfigError, ValidationError, NetworkError) will extend
// this. The top-level handler in `src/bin/freelo.ts` formats them and picks
// the right exit code.

export abstract class BaseError extends Error {
  abstract readonly code: string;
  abstract readonly exitCode: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
  }
}
