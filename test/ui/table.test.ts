import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderTable, truncateCell } from '../../src/ui/table.js';
import { renderProjectsListHuman } from '../../src/ui/human/projects-list.js';
import { type ProjectListData } from '../../src/api/schemas/project.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('truncateCell', () => {
  it('returns the value unchanged when within max', () => {
    expect(truncateCell('short', 10)).toBe('short');
  });

  it('truncates with a single ellipsis character at max length', () => {
    expect(truncateCell('abcdefghij', 5)).toBe('abcd…');
  });

  it('handles max=1 by emitting just the ellipsis', () => {
    expect(truncateCell('hello', 1)).toBe('…');
  });

  it('returns empty string on max <= 0', () => {
    expect(truncateCell('x', 0)).toBe('');
    expect(truncateCell('x', -1)).toBe('');
  });
});

describe('renderTable', () => {
  it('produces a multi-line table with the provided headers and rows', async () => {
    const out = await renderTable(
      ['ID', 'NAME', 'COUNT'],
      [
        ['1', 'Alpha', '3'],
        ['2', 'Beta', '5'],
      ],
    );
    expect(out).toContain('ID');
    expect(out).toContain('NAME');
    expect(out).toContain('Alpha');
    expect(out).toContain('Beta');
    expect(out.split('\n').length).toBeGreaterThan(2);
  });

  it('truncates the configured name column at the given width', async () => {
    const long = 'x'.repeat(50);
    const out = await renderTable(['ID', 'NAME'], [['1', long]], {
      maxNameWidth: 10,
      nameColumnIndex: 1,
    });
    expect(out).toContain('xxxxxxxxx…');
    expect(out).not.toContain('x'.repeat(50));
  });

  it('coerces null and undefined cells to empty strings', async () => {
    const out = await renderTable(['A', 'B'], [
      [null, undefined],
      [1, 'ok'],
    ] as ReadonlyArray<ReadonlyArray<unknown>>);
    expect(out).toContain('ok');
  });
});

describe('renderProjectsListHuman', () => {
  it('uses the with_tasklists default columns and summarises tasklists count', async () => {
    const data: ProjectListData = {
      entity_shape: 'with_tasklists',
      scope: 'owned',
      projects: [
        {
          id: 1,
          name: 'Alpha',
          date_add: '2026-01-01',
          tasklists: [
            { id: 10, name: 'A' },
            { id: 11, name: 'B' },
          ],
        },
      ],
    };
    const out = await renderProjectsListHuman(data);
    expect(out).toContain('ID');
    expect(out).toContain('TASKLISTS');
    expect(out).toContain('Alpha');
    expect(out).toContain('2'); // tasklists count
  });

  it('emits the (no projects) row when the list is empty', async () => {
    const data: ProjectListData = {
      entity_shape: 'with_tasklists',
      scope: 'owned',
      projects: [],
    };
    const out = await renderProjectsListHuman(data);
    expect(out).toContain('(no projects)');
  });

  it('summarises state and owner for entity_shape: full', async () => {
    const data: ProjectListData = {
      entity_shape: 'full',
      scope: 'all',
      projects: [
        {
          id: 1,
          name: 'P',
          state: { id: 1, state: 'active' },
          owner: { id: 9, fullname: 'O' },
        },
      ],
    };
    const out = await renderProjectsListHuman(data);
    expect(out).toContain('STATE');
    expect(out).toContain('active');
  });

  it('honours displayFields ordering when provided', async () => {
    const data: ProjectListData = {
      entity_shape: 'with_tasklists',
      scope: 'owned',
      projects: [{ id: 1, name: 'X' }],
    };
    const out = await renderProjectsListHuman(data, { displayFields: ['name', 'id'] });
    // Header order: NAME before ID.
    const headerLine = out.split('\n').find((l) => l.includes('NAME') && l.includes('ID'));
    expect(headerLine).toBeDefined();
    expect(headerLine!.indexOf('NAME')).toBeLessThan(headerLine!.indexOf('ID'));
  });
});

describe('lazy-import discipline', () => {
  it('src/ui/table.ts has no top-level static import of cli-table3', async () => {
    const p = resolve(__dirname, '../../src/ui/table.ts');
    const src = await readFile(p, 'utf8');
    // Strip block comments so the convention notice in the docstring doesn't
    // give a false negative.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // Match top-level `import ... from 'cli-table3'` (multiline, with whitespace).
    const staticImport = /^\s*import\s[^;]*from\s+['"]cli-table3['"]/m;
    expect(staticImport.test(stripped)).toBe(false);
    // Sanity: the dynamic import is present.
    expect(src).toMatch(/await\s+import\s*\(\s*['"]cli-table3['"]\s*\)/);
  });
});
