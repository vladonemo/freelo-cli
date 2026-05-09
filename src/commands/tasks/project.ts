import { type Command } from 'commander';
import { type GetAppConfig } from '../../config/schema.js';
import { registerProjectAdd } from './project/add.js';
import { registerProjectRemove } from './project/remove.js';

/**
 * Register the `tasks project` parent subcommand on `tasks` (R38, spec 0052).
 *
 * Mirrors the shape of `src/commands/tasks/estimate.ts` / `src/commands/tasks/remind.ts`:
 * parent carries no `meta` and no action — just children. Each leaf has its
 * own `meta`, its own action, its own envelope schema.
 *
 * The two leaves manage **multi-project membership** (UVVP) — `add` promotes
 * a single-project task into a cross-team task by creating a child task in
 * another project (POST /task/{id}/projects). `remove` rolls that back
 * (DELETE /task/{id}/projects/{project_id}). See spec 0052 decision 1 for
 * the parent + leaves rationale.
 *
 * Note: `add` takes `--tasklist <id>...` (NOT `--project <id>` as the roadmap
 * suggested) because the OpenAPI body shape requires a tasklist id —
 * the project is derived from the tasklist by Freelo. See spec 0052 decision 2.
 */
export function registerProject(
  tasks: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const project = tasks
    .command('project')
    .description(
      'Manage which projects a task is visible in (multi-project membership, UVVP). Promotes a single-project task into a cross-team task by creating a child in another project, or rolls back an accidental cross-team assignment.',
    );

  registerProjectAdd(project, getConfig, env);
  registerProjectRemove(project, getConfig, env);
}
