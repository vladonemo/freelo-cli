import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { registerEstimateSet } from './estimate/set.js';
import { registerEstimateClear } from './estimate/clear.js';

/**
 * Register the `tasks estimate` parent subcommand on `tasks` (R37, spec 0051).
 *
 * Mirrors the shape of `src/commands/tasks/remind.ts`: parent carries no
 * `meta` and no action — just children. Each leaf has its own `meta`, its
 * own action, its own envelope schema.
 *
 * The two leaves (`set`, `clear`) share the `--user <id>` toggle which
 * flips between the team-wide total-estimate endpoint and the per-user
 * endpoint. See spec 0051 decision 1 for the parent + leaves rationale and
 * decision 2 for the path-toggle rationale.
 */
export function registerEstimate(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const estimate = tasks
    .command('estimate')
    .description(
      "Manage a task's time estimate (total or per-user). Total estimates are the team-wide effort budget; per-user estimates are individual capacity allocations. Per-user estimates are independent — setting one does NOT update the total.",
    );

  registerEstimateSet(estimate, getConfig, env);
  registerEstimateClear(estimate, getConfig, env);
}
