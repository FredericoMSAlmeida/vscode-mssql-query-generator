# Fluent Grid Generate SELECT/UPDATE/DELETE/INSERT + WHERE...IN — Design

## Goal

Port the legacy SlickGrid results grid's "Generate SELECT/UPDATE/DELETE/INSERT" context-menu feature (including the WHERE...IN multi-row single-column variant and table-name fallback) to the new Fluent results grid (`FluentResultGrid`, behind `mssql.previewFeatures.betaResultsGrid`), reaching full feature parity between the two grids.

## Background / why this design, not the originally assumed one

An earlier investigation ([[project_fluent_grid_generate_porting]], pre-correction) assumed Fluent grid's existing `CopyAsInClause`/`CopyAsInsertInto` commands — which call `queryRunner.copyResults2()` — could be extended server-side to also emit full SELECT/UPDATE/DELETE statements, avoiding a client-side port of `sqlScriptGenerator.ts`.

This is wrong. `copyResults2` (`extensions/mssql/src/controllers/queryRunner.ts:1107-1282`) does no local generation: it forwards a `CopyResults2Request` to SQL Tools Service (a separate C# repo, out of this workspace), whose `CopyType` enum is fixed at `Text/JSON/CSV/INSERT/IN`. Legacy's actual Generate logic, in `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`, was **always** 100% client-side — STS is only involved for table-name resolution, which is already a grid-agnostic RPC (`ResolveTableNameRequest`) and needs no change.

So this design ports the client-side generation approach, adapted to Fluent grid's command/data architecture, rather than extending the server-side copy pipeline.

## Scope

Full parity: single-row Generate SELECT/UPDATE/DELETE, full-row Generate INSERT, table-name fallback (`FallbackTableName`, via `ResolveTableNameRequest`), and the multi-row single-column WHERE...IN variant of SELECT/UPDATE/DELETE (INSERT excluded from that shape, matching legacy).

Out of scope: fixing the pre-existing gap where Fluent's `CopyAsInClause`/`CopyAsInsertInto` commands show unconditionally (no `isVisible` shape gating) — left as-is, not touched by this work, may be addressed separately later.

## Architecture

### 1. New commands

Add to `FluentResultGridCommand` (`extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommandIds.ts`): `GenerateSelect`, `GenerateUpdate`, `GenerateDelete`, `GenerateInsert` (namespaced `fluentResultGrid.generateSelect` etc., matching existing convention).

Contribute them in `getQueryResultFluentGridCommandConfiguration()` (`extensions/mssql/src/webviews/pages/QueryResult/queryResultFluentResultGrid.tsx`), placed in `CellContextMenu`, `groupId: "copyAs"` (or a new adjacent group), ordered after `CopyAsInsertInto`. Each gets a real `isVisible(context)` predicate built from the ported shape-gating helpers (below) — unlike the existing two Copy commands in this area, which have none.

No change needed to `isFluentResultGridHostCommand` (`fluentResultGridCommandUtils.ts`) — it treats any unrecognized command id as a host command by default, which is what we want (forwarded up to the page's `onCommand`).

### 2. Selection resolution

`useFluentResultGridCommandController`'s `getSelectionForCommand` switch (`fluentResultGridCommandController.ts:189-216`) must route the four new command ids through the same branch as `CopyAsInClause`/`CopyAsInsertInto` (`getActualSelectionForCopy(grid)`), so selection ranges are mapped from displayed (sorted/filtered) rows back to actual data rows — the same mapping Copy already relies on.

`isSingleRowSelection`/`isFullRowSelected`/`isSingleColumnMultiRowSelection` (from `sqlScriptGenerator.ts`) port unchanged: both grids' selection type is `ISlickRange[]`.

### 3. Data access plumbing (the one real gap)

Legacy's `contextMenu.plugin.ts` reads cell values via `this.grid.getData().getItem(row)` (a `IDisposableDataProvider`). Fluent's underlying grid is still a real `SlickGrid` (via slickgrid-react) with a working `getDataItem(row)` / `getColumns()` — `fluentResultGridCommandController.ts`'s `handleClick` already calls `grid.getDataItem(args.row)` today. The gap is purely that this grid reference never reaches the page-level consumer: `emitHostCommand` (same file) has `grid` in scope but only forwards the `FluentResultGridCommandEvent` to `onCommand`, whose type (`FluentResultGridProps.onCommand`, `fluentResultGridProps.ts:48`) takes a single argument.

Fix: extend `FluentResultGridProps.onCommand` to `(event: FluentResultGridCommandEvent, grid: SlickGrid<FluentResultGridDataRow>) => MaybePromise<void>` — an added second parameter, backward compatible (existing single-consumer call site just gains access it can ignore). `emitHostCommand` passes its already-in-scope `grid` through.

Only one real consumer wires `onCommand` today (`queryResultFluentResultGrid.tsx`), so blast radius is one call site.

### 4. Generation logic

In `queryResultFluentResultGrid.tsx`'s `handleCommand`, add a case block for the four new command ids mirroring legacy's `contextMenu.plugin.ts` dispatch structure: determine single-row vs. multi-row-single-column via the ported shape helpers, call `ResolveTableNameRequest`, then call `sqlScriptGenerator.ts`'s existing `generateSelect`/`generateUpdate`/`generateDelete`/`generateInsertForRows`/`generateSelectIn`/`generateUpdateIn`/`generateDeleteIn` against the Fluent grid + column + data-item accessor, then `OpenGeneratedQueryRequest`.

Whether `sqlScriptGenerator.ts`'s functions (generic over `Slick.Column<T>` / `IDisposableDataProvider<T>`) accept Fluent's `Column<FluentResultGridDataRow>` (from `slickgrid-react`) and a small adapter over `grid.getDataItem` directly, via structural typing, needs verification during planning — expected to be a thin adapter (a tiny wrapper implementing `IDisposableDataProvider<T>.getItem` via `grid.getDataItem`), not a rewrite of the generator functions themselves.

### 5. Table name + open flow

Unchanged: `ResolveTableNameRequest` → `OpenGeneratedQueryRequest`, both already grid-agnostic extension-host handlers (`extensions/mssql/src/queryResult/utils.ts`).

## Testing

- Unit tests for the new command contributions' `isVisible` predicates (per selection shape), analogous to the legacy `contextMenu.plugin.test.ts` shape-gating tests.
- Unit tests for the generation dispatch in `queryResultFluentResultGrid.tsx`, analogous to legacy's dispatch tests, adapted to Fluent's data-item accessor mock.
- Manual F5 verification against the Fluent grid: requires flipping `mssql.previewFeatures.betaResultsGrid` **and** running `npm run build:webviews-bundle` first — the webview bundle is not auto-rebuilt on F5 launch ([[feedback_rebuild_webviews_before_f5]]).

## Non-goals

- Not fixing `CopyAsInClause`/`CopyAsInsertInto`'s missing `isVisible` gating (explicitly deferred, per user decision during brainstorming).
- Not touching SQL Tools Service / `copyResults2` / `CopyType`.
- Not duplicating `sqlScriptGenerator.ts` — reusing it via a thin data-accessor adapter, not rewriting generation logic for Fluent.
