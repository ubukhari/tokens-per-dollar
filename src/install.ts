/**
 * How to run tokens-per-dollar: the one constant behind every place the command is shown or
 * printed (`--help` and the CLI's own hints, the README and its picture, the plugin skill and
 * marketplace, seatledger's README, and agentcheck's /tokens-per-dollar pages).
 *
 * npm does not serve `tokens-per-dollar` yet, so it runs from the public repo, whose committed
 * dist/ needs no build (scripts/sync-oss-repos.sh). The day npm serves it, flip ON_NPM and rewrite
 * the rest:
 *
 *   TPD_WRITE_INSTALL=1 pnpm --filter tokens-per-dollar exec vitest run src/distribution
 *
 * The GitHub form carries `--allow-git=root`: npm 12 refuses a git spec unless `--allow-git`
 * permits it (its default is `none`), `root` permits only the spec named on the command line,
 * and npm 10 and 11 accept the flag (checked 8 Oct 2026).
 *
 * src/distribution.test.ts fails while any surface names another form of the command.
 */
export const ON_NPM: boolean = false;

export const NAME = "tokens-per-dollar";
export const REPO = `https://github.com/agentwares/${NAME}`;

/** What a person types. */
export const INSTALL = ON_NPM ? `npx ${NAME}` : `npx --allow-git=root github:agentwares/${NAME}`;

/** What an agent runs unattended: no install prompt, and on npm the newest version, not a cached one. */
export const RUN = ON_NPM
  ? `npx -y ${NAME}@latest`
  : `npx -y --allow-git=root github:agentwares/${NAME}`;
