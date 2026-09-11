# Grid Query Generation — Debug Session Findings (2026-09-08/09)

Context: debugging session after implementing `2026-09-08-grid-query-generation.md`. Three separate root causes found and fixed, one open issue remains (needs a decision before continuing).

## Fixed issues (in order encountered)

### 1. `mssql.addObjectExplorer` command not found on F5

- **Root cause:** `extensions/mssql/dist/` didn't exist — extension had never been built. `package.json` main entry is `./dist/extension`, and `launch.json` has no `preLaunchTask`, so F5 doesn't build first.
- **Fix:** run `npm run build` from repo root before F5. No code change.

### 2. Build failed: `Node.js 24+ is required. Current version: v22.14.0`

- **Root cause:** repo's build script (`scripts/workspaces.mjs`) hard-requires Node 24+.
- **Fix:** installed `nvm-windows` (via winget) so the global Node install (used by other v22 projects) stays untouched. User runs `nvm use 24` in this repo's shell before building.
- Note: `nvm` needs a **brand-new terminal window** after install — PATH doesn't refresh in already-open shells.

### 3. Build failed: `error TS5042: Option 'project' cannot be mixed with source files on a command line`

- Cause: passing `--target mssql` to `npm run build` leaks `mssql` as a positional arg into a nested `tsc -p tsconfig.json` call. Not investigated further — **workaround: just run `npm run build` with no target**, builds all workspaces fine.

### 4. Build failed: 38 `TS2304: Cannot find name 'JQuery'/'jQuery'` errors

- **Root cause:** Task 5 of the plan added `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`, which imports the real `contextMenu.plugin.ts` class. `test/` is inside `tsconfig.extension.json`'s `include`, so this pulled `table.ts` → `autoColumnSize.plugin.ts` / `cellRangeSelector.ts` / `headerFilter.plugin.ts` (all use global `jQuery`) into the **extension** typecheck project — which restricts ambient globals via `tsconfig.base.json` (`"types": ["node", "mocha"]`, no jquery). This wasn't broken before because nothing under `test/` previously touched jQuery-using webview code.
- **Fix applied:** added `"jquery"` to `compilerOptions.types` in `extensions/mssql/tsconfig.extension.json`. Verified clean with `npx tsgo -p tsconfig.extension.json --noEmit` (the actual checker `npm run build` uses — plain `npx tsc` reports unrelated pre-existing noise from different module-resolution defaults, ignore that).
- **This fix is uncommitted** — sitting in the working tree as of this writing.

### 5. Generate SELECT/UPDATE/DELETE items missing from grid context menu

- **Root cause:** `mssql.preview.betaResultsGrid` defaults to `true` (see `CHANGELOG.md:28` and `extensions/mssql/package.json:1988-1993`) — user was on the **beta/preview results grid**, which the plan explicitly scoped out (legacy grid only). All plan code was correct; wrong grid entirely.
- Complication: the setting doesn't show in Settings UI search when the extension contributing it isn't active in that window (marketplace copy disabled, dev copy only runs in the Debug/Extension Development Host) — had to add it directly to user `settings.json` as raw JSON: `"mssql.preview.betaResultsGrid": false`. It's `"scope": "application"`, so one global `settings.json` edit applies to both normal and debug-host windows; only needed to restart the Extension Development Host, not full VS Code.
- **Confirmed fixed** — Generate items now show correctly on the legacy grid.

## OPEN ISSUE — needs a decision before continuing

### Generate SELECT always falls back to `UnknownTable`, even for simple single-table queries

- **Confirmed root cause** (via forked investigation): `IDbColumn.baseTableName` (and `baseColumnName`/`baseSchemaName`) come back **empty for every query**, not just JOINs/computed columns. This is because SQL Tools Service (STS, the C# backend, **separate repo, not present in this workspace**) never requests ADO.NET's `CommandBehavior.KeyInfo`-equivalent extended column metadata when executing queries. Without that, SQL Server doesn't populate `BaseTableName` etc. in the column schema at all, regardless of query shape.
- Checked and ruled out: no unused flag on the TypeScript side to flip — `QueryExecuteParams` (`extensions/mssql/src/models/contracts/queryExecute.ts:117`) has no metadata-detail option. This is not fixable from this repo alone.
- **This means the plan's core assumption is broken for the common case**, not just the documented edge case ("multi-table query fallback" was supposed to be the _only_ time `UnknownTable` shows up — see plan Task 7 Step 6).

### Two options going forward (pick up tomorrow)

1. **Fix STS** — separate repo/PR, C# change to request extended column metadata on query execution. Correct long-term fix, but out of scope for this repo/session.
2. **Client-side fallback** — parse the table name out of the query's `FROM` clause text for the single-table case. The plan's Architecture section explicitly ruled this out ("No SQL Tools Service round trip, no FROM-clause parsing"), but given `baseTableName` is effectively non-functional in practice, some fallback is needed or the feature is useless as shipped.
3. **Worth checking first**: the existing "Edit Data" preview feature (see `CHANGELOG.md` — Public Preview, `mssql.enableExperimentalFeatures`) also needs a real table name to issue UPDATE/INSERT/DELETE against a live grid. It likely already solved "given a result set, find the real backing table" some other way — worth investigating that code path before choosing between options 1 and 2, since it might already have a working, precedented answer.

**Next session should start here**: decide direction (probably start by checking how Edit Data resolves its table name), before writing any more code.
