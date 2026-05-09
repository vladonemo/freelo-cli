/**
 * Unit tests for `buildCreateProjectFromTemplateBody` (R31, spec 0044).
 *
 * Pure mapping function — no I/O, no MSW. Asserts the CLI input shape
 * produces the right `POST /project/create-from-template/{template_id}` wire
 * body (OpenAPI :785-814).
 */

import { describe, expect, it } from 'vitest';
import {
  buildCreateProjectFromTemplateBody,
  createProjectFromTemplatePath,
} from '../../src/api/projects-create-from-template.js';

describe('buildCreateProjectFromTemplateBody', () => {
  it('minimal input → name only', () => {
    const body = buildCreateProjectFromTemplateBody({ templateId: 4567, name: 'Acme Q3' });
    expect(body).toEqual({ name: 'Acme Q3' });
    expect(Object.keys(body)).toEqual(['name']);
  });

  it('with ownerId → emits project_owner_id', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      ownerId: 314,
    });
    expect(body).toEqual({ name: 'X', project_owner_id: 314 });
  });

  it('with currency → emits currency_iso (uppercase by contract)', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      currency: 'EUR',
    });
    expect(body).toEqual({ name: 'X', currency_iso: 'EUR' });
  });

  it('with dateStart → emits preset_date_from passthrough', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      dateStart: '2026-09-01',
    });
    expect(body).toEqual({ name: 'X', preset_date_from: '2026-09-01' });
  });

  it('with layout → emits nested general_settings.layout', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      layout: 'kanban',
    });
    expect(body).toEqual({ name: 'X', general_settings: { layout: 'kanban' } });
  });

  it('with workers (non-empty) → emits users_ids array', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      workers: [12, 34],
    });
    expect(body).toEqual({ name: 'X', users_ids: [12, 34] });
  });

  it('with workers (empty array) → users_ids omitted', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      workers: [],
    });
    expect(body).toEqual({ name: 'X' });
    expect(body).not.toHaveProperty('users_ids');
  });

  it('with all fields → full snake-case body', () => {
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'Acme Q3',
      ownerId: 314,
      currency: 'EUR',
      dateStart: '2026-09-01',
      layout: 'kanban',
      workers: [12, 34],
    });
    expect(body).toEqual({
      name: 'Acme Q3',
      project_owner_id: 314,
      currency_iso: 'EUR',
      preset_date_from: '2026-09-01',
      general_settings: { layout: 'kanban' },
      users_ids: [12, 34],
    });
  });

  it('does not emit undefined optional fields', () => {
    const body = buildCreateProjectFromTemplateBody({ templateId: 4567, name: 'X' });
    // Clean single-key object; no `project_owner_id: undefined` etc.
    expect(Object.keys(body)).toEqual(['name']);
  });

  it('clones the workers array (callers cannot mutate emitted body via input)', () => {
    const workers = [12, 34];
    const body = buildCreateProjectFromTemplateBody({
      templateId: 4567,
      name: 'X',
      workers,
    });
    expect(body.users_ids).toEqual([12, 34]);
    // Mutate the original; the body should be unaffected.
    workers.push(99);
    expect(body.users_ids).toEqual([12, 34]);
  });
});

describe('createProjectFromTemplatePath', () => {
  it('builds the path with the integer template_id', () => {
    expect(createProjectFromTemplatePath(4567)).toBe('/project/create-from-template/4567');
  });

  it('does not URL-encode (template_id is integer)', () => {
    expect(createProjectFromTemplatePath(1)).toBe('/project/create-from-template/1');
  });
});
