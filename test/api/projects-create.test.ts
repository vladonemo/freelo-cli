/**
 * Unit tests for `buildCreateProjectBody` (R29, spec 0042).
 *
 * Pure mapping function — no I/O, no MSW. Asserts the CLI input shape
 * produces the right `POST /projects` wire body.
 */

import { describe, expect, it } from 'vitest';
import { buildCreateProjectBody } from '../../src/api/projects-create.js';

describe('buildCreateProjectBody', () => {
  it('minimal input → name + currency_iso only', () => {
    const body = buildCreateProjectBody({ name: 'Q3 onboarding', currency: 'EUR' });
    expect(body).toEqual({ name: 'Q3 onboarding', currency_iso: 'EUR' });
    expect(body).not.toHaveProperty('project_owner_id');
  });

  it('with projectOwnerId → emits project_owner_id', () => {
    const body = buildCreateProjectBody({
      name: 'Acme migration',
      currency: 'CZK',
      projectOwnerId: 314,
    });
    expect(body).toEqual({
      name: 'Acme migration',
      currency_iso: 'CZK',
      project_owner_id: 314,
    });
  });

  it('does not emit undefined optional fields', () => {
    const body = buildCreateProjectBody({ name: 'X', currency: 'USD' });
    // The body must be a clean two-key object — no `project_owner_id: undefined`
    // sneaking onto the wire (would JSON-serialize as a missing key, but we
    // assert structurally to keep the contract tight).
    expect(Object.keys(body)).toEqual(['name', 'currency_iso']);
  });

  it('preserves the currency casing supplied (CLI is responsible for upper-casing)', () => {
    // The CLI flag parser uppercases before calling the builder. The builder
    // itself trusts its input (`ProjectCurrency` is a typed union of upper-
    // case codes). Document that contract here.
    const body = buildCreateProjectBody({ name: 'X', currency: 'EUR' });
    expect(body.currency_iso).toBe('EUR');
  });
});
