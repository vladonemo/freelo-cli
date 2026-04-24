/**
 * Thin wrapper around chalk that lazily loads it on first access.
 * Only used in `human` mode renderers — never imported on agent paths.
 *
 * Usage:
 *   const { label } = await getStyles();
 *   process.stdout.write(`${label('Profile:')} default\n`);
 */

type Styles = {
  label: (s: string) => string;
  faint: (s: string) => string;
  bold: (s: string) => string;
};

let _styles: Styles | undefined;

export async function getStyles(): Promise<Styles> {
  if (_styles) return _styles;
  const chalk = await import('chalk');
  const c = new chalk.Chalk();
  _styles = {
    label: (s: string) => c.dim(s),
    faint: (s: string) => c.dim(s),
    bold: (s: string) => c.bold(s),
  };
  return _styles;
}
