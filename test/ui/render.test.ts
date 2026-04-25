import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../src/ui/render.js';
import type { Envelope } from '../../src/ui/envelope.js';

describe('render — json mode', () => {
  let stdoutWrites: string[] = [];

  beforeEach(() => {
    stdoutWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a single newline-terminated JSON line to stdout', () => {
    const envelope: Envelope<{ user_id: number }> = {
      schema: 'freelo.auth.whoami/v1',
      data: { user_id: 42 },
    };
    render('json', envelope, () => '');
    expect(stdoutWrites).toHaveLength(1);
    expect(stdoutWrites[0]).toBe(`${JSON.stringify(envelope)}\n`);
  });

  it('output is JSON-parseable', () => {
    const envelope: Envelope<{ user_id: number }> = {
      schema: 'freelo.auth.whoami/v1',
      data: { user_id: 42 },
    };
    render('json', envelope, () => '');
    const parsed = JSON.parse(stdoutWrites[0]!.trim()) as Envelope<{ user_id: number }>;
    expect(parsed.schema).toBe('freelo.auth.whoami/v1');
    expect(parsed.data.user_id).toBe(42);
  });

  it('does not call the humanRenderer in json mode', () => {
    const humanRenderer = vi.fn(() => 'human output');
    render('json', { schema: 'freelo.auth.whoami/v1', data: {} }, humanRenderer);
    expect(humanRenderer).not.toHaveBeenCalled();
  });
});

describe('render — ndjson mode', () => {
  let stdoutWrites: string[] = [];

  beforeEach(() => {
    stdoutWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a single newline-terminated JSON line for single-record outputs (same as json)', () => {
    const envelope: Envelope<{ profile: string }> = {
      schema: 'freelo.auth.logout/v1',
      data: { profile: 'default' },
    };
    render('ndjson', envelope, () => '');
    expect(stdoutWrites).toHaveLength(1);
    expect(stdoutWrites[0]).toBe(`${JSON.stringify(envelope)}\n`);
  });
});

describe('render — human mode', () => {
  let stdoutWrites: string[] = [];

  beforeEach(() => {
    stdoutWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the humanRenderer with the envelope data', () => {
    const humanRenderer = vi.fn(() => 'human text output');
    const envelope: Envelope<{ user_id: number }> = {
      schema: 'freelo.auth.whoami/v1',
      data: { user_id: 42 },
    };
    render('human', envelope, humanRenderer);
    expect(humanRenderer).toHaveBeenCalledWith(envelope.data);
  });

  it('writes the humanRenderer return value to stdout', () => {
    render('human', { schema: 'freelo.auth.whoami/v1', data: {} }, () => 'readable output');
    expect(stdoutWrites.join('')).toContain('readable output');
  });

  it('appends a newline if the humanRenderer output does not end with one', () => {
    render('human', { schema: 'freelo.auth.whoami/v1', data: {} }, () => 'no newline');
    expect(stdoutWrites[0]).toBe('no newline\n');
  });

  it('does not double-append a newline if the humanRenderer output already ends with one', () => {
    render('human', { schema: 'freelo.auth.whoami/v1', data: {} }, () => 'with newline\n');
    expect(stdoutWrites[0]).toBe('with newline\n');
  });
});
