# Fluent Grid Generate SELECT/UPDATE/DELETE/INSERT + WHERE...IN Porting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this session executes inline, no subagents, no worktree — see spec/user directive). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the legacy SlickGrid results grid's "Generate SELECT/UPDATE/DELETE/INSERT" (+ WHERE...IN multi-row single-column) context-menu feature to the new Fluent results grid, reaching full parity.

**Architecture:** De-genericize `sqlScriptGenerator.ts` off SlickGrid-specific types so it becomes grid-agnostic; add a small, directly-testable orchestrator module (`fluentGenerateQuery.ts`) that reuses it against Fluent's data shape; thread a minimal row-accessor through Fluent's existing command-dispatch plumbing; wire four new commands into the Fluent grid's command contribution config.

**Tech Stack:** TypeScript, mocha/chai (`vscode-test` unit test harness), sinon.

**Spec:** `docs/superpowers/specs/2026-09-10-fluent-grid-generate-porting-design.md`

## Global Constraints

- Full parity scope: single-row Generate SELECT/UPDATE/DELETE, full-row Generate INSERT, table-name fallback, and the multi-row single-column WHERE...IN variant of SELECT/UPDATE/DELETE (INSERT excluded from that shape) — same as legacy.
- Do NOT touch Fluent's existing `CopyAsInClause`/`CopyAsInsertInto` commands' missing `isVisible` gating — explicitly out of scope (user decision during brainstorming).
- Do NOT touch SQL Tools Service / `copyResults2` / `CopyType` — dead end, confirmed during investigation.
- Reuse `sqlScriptGenerator.ts`'s generation logic via a thin adapter — do not duplicate/rewrite the generation logic for Fluent.
- `ResolveTableNameRequest` / `OpenGeneratedQueryRequest` are reused unchanged (already grid-agnostic).
- No worktree, no subagents — this plan executes inline, in the current session, task by task, by the same agent.

---

## File Structure

- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts` — de-genericize (`GeneratorColumn`, `GeneratorDataProvider` replace `Slick.Column<T>`/`IDisposableDataProvider<T>`).
- Modify: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts` — update test helper casts to match.
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommandIds.ts` — add 4 new command ids.
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts` — add `fluentResultGridCommandUsesActualCopySelection` helper, wire new commands into `getSelectionForCommand`, thread row accessor through `emitHostCommand`.
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommands.ts` — add `dataColumnCount?: number` to `FluentResultGridCommandContext`.
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridProps.ts` — extend `onCommand` signature with a 2nd `rowAccessor` param.
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/internal/useFluentResultGridController.ts` — populate `dataColumnCount` in the `commandContext` memo.
- Create: `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts` — new pure module: column adapter, shape-gating predicates, SQL-resolution dispatch, and a pure command orchestrator.
- Create: `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts` — tests for the above.
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/queryResultFluentResultGrid.tsx` — contribute the 4 new commands with `isVisible`, add dispatch case in `handleCommand`.
- Modify: `extensions/mssql/test/unit/fluentResultGrid.test.ts` — test for `fluentResultGridCommandUsesActualCopySelection`.

---

### Task 1: De-genericize `sqlScriptGenerator.ts`

**Files:**

- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`
- Modify: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`

**Interfaces:**

- Produces: `GeneratorColumn { id?: string; field?: string; toolTip?: string; name?: string }`, `GeneratorDataProvider { getItem(row: number): Slick.SlickData }` — used by every later task that calls into this module from the Fluent side.
- All previously-generic functions (`getColumnInfo`, `getAllDataColumnIndices`, `getSelectedColumnIndices`, `isFullRowSelected`, `isSingleColumnMultiRowSelection`, `getColumnValuePair`, `generateSelect`, `generateDelete`, `generateUpdate`, `generateInsertForRows`, `generateSelectIn`, `generateDeleteIn`, `generateUpdateIn`) drop their `<T extends Slick.SlickData>` type parameter and take `GeneratorColumn[]` / `GeneratorDataProvider` instead of `Slick.Column<T>[]` / `IDisposableDataProvider<T>`. `ColumnValuePair` also drops its type parameter (`column: GeneratorColumn` instead of `Slick.Column<T>`).
- This is a **pure type-level refactor** — no runtime behavior changes. Legacy's `contextMenu.plugin.ts` call sites are unaffected: `Slick.Column<T>[]` is structurally assignable to `GeneratorColumn[]`, and `IDisposableDataProvider<T>` (whose `getItem` returns `T extends Slick.SlickData`) is structurally assignable to `GeneratorDataProvider`, so no call-site changes are needed there.

- [ ] **Step 1: Make the type-level changes**

In `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`:

Remove the now-unused import:

```typescript
import type { IDisposableDataProvider } from "../pages/QueryResult/table/dataProvider";
```

Add, right after the `NUMERIC_SQL_TYPES` constant block (before `isNumericSqlType`):

```typescript
export interface GeneratorColumn {
    id?: string;
    field?: string;
    toolTip?: string;
    name?: string;
}

export interface GeneratorDataProvider {
    getItem(row: number): Slick.SlickData;
}
```

Then apply these signature replacements (bodies are unchanged — only type annotations move):

```typescript
export function getColumnInfo(
    columnInfo: IDbColumn[],
    col: GeneratorColumn | undefined,
): IDbColumn | undefined {
    const colIndex = col?.field ? parseInt(col.field, 10) : NaN;
    return !isNaN(colIndex) ? columnInfo[colIndex] : undefined;
}

export function getAllDataColumnIndices(columns: GeneratorColumn[]): number[] {
    const result: number[] = [];
    columns.forEach((col, i) => {
        if (col?.id !== "rowNumber" && col?.field) {
            result.push(i);
        }
    });
    return result;
}

export function getSelectedColumnIndices(
    ranges: ISlickRange[],
    columns: GeneratorColumn[],
): number[] {
    const selected = new Set<number>();
    for (const range of ranges) {
        for (let c = range.fromCell; c <= range.toCell; c++) {
            const col = columns[c];
            if (col?.id !== "rowNumber" && col?.field) {
                selected.add(c);
            }
        }
    }
    return [...selected].sort((a, b) => a - b);
}

export function isFullRowSelected(ranges: ISlickRange[], columns: GeneratorColumn[]): boolean {
    const dataColIndices = getAllDataColumnIndices(columns);
    if (!isSingleRowSelection(ranges) || dataColIndices.length === 0) {
        return false;
    }
    const [range] = ranges;
    const minIdx = Math.min(...dataColIndices);
    const maxIdx = Math.max(...dataColIndices);
    return range.fromCell <= minIdx && range.toCell >= maxIdx;
}

export function isSingleColumnMultiRowSelection(
    ranges: ISlickRange[],
    columns: GeneratorColumn[],
): boolean {
    return (
        getSelectedColumnIndices(ranges, columns).length === 1 && getSelectedRows(ranges).length > 1
    );
}

export interface ColumnValuePair {
    column: GeneratorColumn;
    dbColumn: IDbColumn | undefined;
    cellValue: DbCellValue | undefined;
}

export function getColumnValuePair(
    colIndex: number,
    row: number,
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
): ColumnValuePair {
    const column = columns[colIndex];
    const item = dataProvider.getItem(row) as Slick.SlickData;
    const cellValue = column?.field ? (item?.[column.field] as DbCellValue | undefined) : undefined;
    return { column, dbColumn: getColumnInfo(columnInfo, column), cellValue };
}

export function getColumnIdentifier(pair: ColumnValuePair): string {
    return pair.dbColumn?.baseColumnName || pair.column?.toolTip || pair.column?.name || "";
}

export function formatSqlValue(pair: ColumnValuePair): string {
    if (!pair.cellValue || pair.cellValue.isNull) {
        return "NULL";
    }
    const val = pair.cellValue.displayValue ?? "";
    return isNumericSqlType(pair.dbColumn?.dataTypeName) && SQL_NUMBER_PATTERN.test(val)
        ? val
        : sqlStr(val);
}

export function buildWhereClause(pairs: ColumnValuePair[]): string {
    return pairs
        .map((pair) => {
            const colName = escapeSqlIdentifier(getColumnIdentifier(pair));
            if (!pair.cellValue || pair.cellValue.isNull) {
                return `${colName} IS NULL`;
            }
            return `${colName} = ${formatSqlValue(pair)}`;
        })
        .join(" AND ");
}

function getRowPairs(
    colIndices: number[],
    row: number,
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
): ColumnValuePair[] {
    return colIndices.map((i) => getColumnValuePair(i, row, columns, dataProvider, columnInfo));
}

function getColumnPairsForRows(
    colIndex: number,
    rows: number[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
): ColumnValuePair[] {
    return rows.map((r) => getColumnValuePair(colIndex, r, columns, dataProvider, columnInfo));
}

function buildInClauseValues(pairs: ColumnValuePair[]): string[] {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const pair of pairs) {
        if (!pair.cellValue || pair.cellValue.isNull) {
            continue;
        }
        const formatted = formatSqlValue(pair);
        if (!seen.has(formatted)) {
            seen.add(formatted);
            values.push(formatted);
        }
    }
    return values;
}

export function buildInClause(pairs: ColumnValuePair[]): string | undefined {
    if (pairs.length === 0) {
        return undefined;
    }
    const values = buildInClauseValues(pairs);
    if (values.length === 0) {
        return undefined;
    }
    const colName = escapeSqlIdentifier(getColumnIdentifier(pairs[0]));
    return `${colName} IN (${values.join(", ")})`;
}

export function generateSelect(
    row: number,
    selectedColumnIndices: number[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string {
    const eol = getEOL();
    const allPairs = getRowPairs(
        getAllDataColumnIndices(columns),
        row,
        columns,
        dataProvider,
        columnInfo,
    );
    const wherePairs = getRowPairs(selectedColumnIndices, row, columns, dataProvider, columnInfo);
    const colNames = allPairs.map((p) => escapeSqlIdentifier(getColumnIdentifier(p))).join(", ");
    const table = buildQualifiedTableName(
        wherePairs[0]?.dbColumn ?? allPairs[0]?.dbColumn,
        fallback,
    );
    return `SELECT ${colNames}${eol}FROM ${table}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateDelete(
    row: number,
    selectedColumnIndices: number[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string {
    const eol = getEOL();
    const wherePairs = getRowPairs(selectedColumnIndices, row, columns, dataProvider, columnInfo);
    const table = buildQualifiedTableName(wherePairs[0]?.dbColumn, fallback);
    return `DELETE FROM ${table}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateUpdate(
    row: number,
    selectedColumnIndices: number[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string {
    const eol = getEOL();
    const wherePairs = getRowPairs(selectedColumnIndices, row, columns, dataProvider, columnInfo);
    const whereFields = new Set(wherePairs.map((p) => p.column.field));
    const setPairs = getRowPairs(
        getAllDataColumnIndices(columns),
        row,
        columns,
        dataProvider,
        columnInfo,
    ).filter((p) => !whereFields.has(p.column.field));
    const table = buildQualifiedTableName(
        wherePairs[0]?.dbColumn ?? setPairs[0]?.dbColumn,
        fallback,
    );
    const setClause = setPairs
        .map((p) => `${escapeSqlIdentifier(getColumnIdentifier(p))} = ${formatSqlValue(p)}`)
        .join(`,${eol}    `);
    return `UPDATE ${table}${eol}SET ${setClause}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateInsertForRows(
    ranges: ISlickRange[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string {
    const eol = getEOL();
    const colIndices = getSelectedColumnIndices(ranges, columns);
    const colMeta = colIndices.map((i) => ({
        index: i,
        column: columns[i],
        dbColumn: getColumnInfo(columnInfo, columns[i]),
    }));

    const valueRows: string[] = [];
    for (const range of ranges) {
        for (let r = range.fromRow; r <= range.toRow; r++) {
            const values = colMeta.map(({ index }) =>
                isCellSelected(ranges, r, index)
                    ? formatSqlValue(
                          getColumnValuePair(index, r, columns, dataProvider, columnInfo),
                      )
                    : "NULL",
            );
            valueRows.push(`    (${values.join(", ")})`);
        }
    }

    if (colMeta.length === 0 || valueRows.length === 0) {
        return "";
    }

    const colNames = colMeta
        .map(({ column, dbColumn }) =>
            escapeSqlIdentifier(dbColumn?.baseColumnName || column.toolTip || column.name || ""),
        )
        .join(", ");
    const table = buildQualifiedTableName(colMeta[0]?.dbColumn, fallback);
    const statements: string[] = [];
    for (let start = 0; start < valueRows.length; start += INSERT_ROW_LIMIT) {
        const batch = valueRows.slice(start, start + INSERT_ROW_LIMIT);
        const rowLines = batch.map((row, i) => row + (i < batch.length - 1 ? "," : ";"));
        statements.push([`INSERT INTO ${table} (${colNames})`, "VALUES", ...rowLines].join(eol));
    }
    return statements.join(eol + eol);
}

export function generateSelectIn(
    ranges: ISlickRange[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string | undefined {
    const eol = getEOL();
    const colIndex = getSelectedColumnIndices(ranges, columns)[0];
    const rows = getSelectedRows(ranges);
    const pairs = getColumnPairsForRows(colIndex, rows, columns, dataProvider, columnInfo);
    const inClause = buildInClause(pairs);
    if (!inClause) {
        return undefined;
    }
    const allPairs = getRowPairs(
        getAllDataColumnIndices(columns),
        rows[0],
        columns,
        dataProvider,
        columnInfo,
    );
    const colNames = allPairs.map((p) => escapeSqlIdentifier(getColumnIdentifier(p))).join(", ");
    const table = buildQualifiedTableName(pairs[0]?.dbColumn ?? allPairs[0]?.dbColumn, fallback);
    return `SELECT ${colNames}${eol}FROM ${table}${eol}WHERE ${inClause};`;
}

export function generateDeleteIn(
    ranges: ISlickRange[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string | undefined {
    const eol = getEOL();
    const colIndex = getSelectedColumnIndices(ranges, columns)[0];
    const rows = getSelectedRows(ranges);
    const pairs = getColumnPairsForRows(colIndex, rows, columns, dataProvider, columnInfo);
    const inClause = buildInClause(pairs);
    if (!inClause) {
        return undefined;
    }
    const table = buildQualifiedTableName(pairs[0]?.dbColumn, fallback);
    return `DELETE FROM ${table}${eol}WHERE ${inClause};`;
}

export function generateUpdateIn(
    ranges: ISlickRange[],
    columns: GeneratorColumn[],
    dataProvider: GeneratorDataProvider,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string | undefined {
    const eol = getEOL();
    const colIndex = getSelectedColumnIndices(ranges, columns)[0];
    const rows = getSelectedRows(ranges);
    const pairs = getColumnPairsForRows(colIndex, rows, columns, dataProvider, columnInfo);
    const inClause = buildInClause(pairs);
    if (!inClause) {
        return undefined;
    }
    const table = buildQualifiedTableName(pairs[0]?.dbColumn, fallback);
    return `UPDATE ${table}${eol}SET /* TODO: specify columns and values to update */${eol}WHERE ${inClause};`;
}
```

(`isSingleColumnMultiRowSelection` takes no `<T>` already had none tied to columns beyond what's now `GeneratorColumn[]` above; `isSingleRowSelection`, `isCellSelected`, `buildQualifiedTableName`, `sqlStr`, `escapeSqlIdentifier`, `isNumericSqlType`, `getEOL`, `getSelectedRows` are untouched — they never referenced `Slick.Column<T>`/`IDisposableDataProvider<T>`.)

- [ ] **Step 2: Update the test file's helper casts**

In `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`, replace:

```typescript
import type { IDisposableDataProvider } from "../../../src/webviews/pages/QueryResult/table/dataProvider";
```

with:

```typescript
import type {
    GeneratorColumn,
    GeneratorDataProvider,
} from "../../../src/webviews/common/sqlScriptGenerator";
```

(add `GeneratorColumn, GeneratorDataProvider` to the existing named-import list from `sqlScriptGenerator` a few lines below, rather than a second import statement).

Replace:

```typescript
function makeCol(index: number, name: string, toolTip?: string): Slick.Column<Slick.SlickData> {
    return {
        field: String(index),
        id: String(index),
        name,
        toolTip,
    } as Slick.Column<Slick.SlickData>;
}
```

with:

```typescript
function makeCol(index: number, name: string, toolTip?: string): GeneratorColumn {
    return {
        field: String(index),
        id: String(index),
        name,
        toolTip,
    };
}
```

Replace:

```typescript
function makeProvider(rows: CellRow[]): IDisposableDataProvider<Slick.SlickData> {
    return {
        getItem: (row: number) => rows[row] ?? {},
    } as unknown as IDisposableDataProvider<Slick.SlickData>;
}
```

with:

```typescript
function makeProvider(rows: CellRow[]): GeneratorDataProvider {
    return {
        getItem: (row: number) => rows[row] ?? {},
    };
}
```

- [ ] **Step 3: Run the full existing suite and confirm no regressions**

Run: `cd extensions/mssql && npm test -- --grep sqlScriptGenerator`
Expected: PASS, same test count as before this task (this is a pure type refactor — no assertions should change).

Also run the full suite once to make sure nothing else in the codebase broke from the signature change:

Run: `cd extensions/mssql && npm run compile` (or the project's TypeScript check script — use whichever `package.json` script runs `tsc --noEmit`; check `build:extension:typecheck`)
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add extensions/mssql/src/webviews/common/sqlScriptGenerator.ts extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts
git commit -m "refactor: de-genericize sqlScriptGenerator.ts off SlickGrid-specific types"
```

---

### Task 2: New Fluent command ids + selection routing helper

**Files:**

- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommandIds.ts`
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts`
- Test: `extensions/mssql/test/unit/fluentResultGrid.test.ts`

**Interfaces:**

- Produces: `FluentResultGridCommand.GenerateSelect/GenerateUpdate/GenerateDelete/GenerateInsert` (string ids), `fluentResultGridCommandUsesActualCopySelection(commandId: string): boolean` — both consumed by Task 7.

- [ ] **Step 1: Write the failing test**

In `extensions/mssql/test/unit/fluentResultGrid.test.ts`, add to the existing `import` from `"../../src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController"` (find the existing import block that pulls from this module and add `fluentResultGridCommandUsesActualCopySelection` to it), then add this test inside the existing `suite("commands", ...)` block (after the `isFluentResultGridHostCommand` test):

```typescript
test("routes Copy and Generate commands through the actual (data-mapped) selection", () => {
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.CopySelection),
    ).to.equal(true);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.CopyAsInClause),
    ).to.equal(true);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.GenerateSelect),
    ).to.equal(true);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.GenerateUpdate),
    ).to.equal(true);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.GenerateDelete),
    ).to.equal(true);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.GenerateInsert),
    ).to.equal(true);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.SaveAsCsv),
    ).to.equal(false);
    expect(
        fluentResultGridCommandUsesActualCopySelection(FluentResultGridCommand.ToggleSort),
    ).to.equal(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/mssql && npm test -- --grep "routes Copy and Generate commands"`
Expected: FAIL — compile error, `FluentResultGridCommand.GenerateSelect` and `fluentResultGridCommandUsesActualCopySelection` don't exist yet.

- [ ] **Step 3: Add the command ids**

In `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommandIds.ts`, add after `CopyColumnName: "fluentResultGrid.copyColumnName",`:

```typescript
    GenerateSelect: "fluentResultGrid.generateSelect",
    GenerateUpdate: "fluentResultGrid.generateUpdate",
    GenerateDelete: "fluentResultGrid.generateDelete",
    GenerateInsert: "fluentResultGrid.generateInsert",
```

- [ ] **Step 4: Add and wire the selection-routing helper**

In `extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts`, add this exported function right before `useFluentResultGridCommandController`:

```typescript
export function fluentResultGridCommandUsesActualCopySelection(commandId: string): boolean {
    switch (commandId) {
        case FluentResultGridCommand.CopySelection:
        case FluentResultGridCommand.CopyWithHeaders:
        case FluentResultGridCommand.CopyAsCsv:
        case FluentResultGridCommand.CopyAsJson:
        case FluentResultGridCommand.CopyAsInClause:
        case FluentResultGridCommand.CopyAsInsertInto:
        case FluentResultGridCommand.GenerateSelect:
        case FluentResultGridCommand.GenerateUpdate:
        case FluentResultGridCommand.GenerateDelete:
        case FluentResultGridCommand.GenerateInsert:
            return true;
        default:
            return false;
    }
}
```

Then replace the `getSelectionForCommand` callback's switch (the block with the `case FluentResultGridCommand.CopySelection: ... return getActualSelectionForCopy(grid);` group) with:

```typescript
const getSelectionForCommand = useCallback(
    (grid: SlickGrid, commandId: string): ISlickRange[] | undefined => {
        if (fluentResultGridCommandUsesActualCopySelection(commandId)) {
            return getActualSelectionForCopy(grid);
        }
        switch (commandId) {
            case FluentResultGridCommand.SaveAsCsv:
            case FluentResultGridCommand.SaveAsJson:
            case FluentResultGridCommand.SaveAsExcel:
            case FluentResultGridCommand.SaveAsInsert:
                return getSelectionForSave(grid);
            case FluentResultGridCommand.CopyHeaders:
                // Only the cell bounds are read downstream; the row indexes are discarded, so
                // the displayed selection is equivalent here.
                return getDisplayedFluentResultGridSelectionForCopy(grid, grid.getDataLength());
            default:
                return getFluentResultGridDataSelectionsFromRanges(
                    grid.getSelectionModel()?.getSelectedRanges() ?? [],
                    grid.getColumns(),
                );
        }
    },
    [getActualSelectionForCopy, getSelectionForSave],
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extensions/mssql && npm test -- --grep "routes Copy and Generate commands"`
Expected: PASS.

Run: `cd extensions/mssql && npm test -- --grep "Fluent Result Grid"`
Expected: PASS, no regressions in the rest of that suite.

- [ ] **Step 6: Commit**

```bash
git add extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommandIds.ts extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts extensions/mssql/test/unit/fluentResultGrid.test.ts
git commit -m "feat: add Fluent Generate command ids and selection routing"
```

---

### Task 3: Thread `dataColumnCount` into the command context

**Files:**

- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommands.ts`
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/internal/useFluentResultGridController.ts`

**Interfaces:**

- Produces: `FluentResultGridCommandContext.dataColumnCount?: number` — consumed by Task 4's shape-gating predicates and Task 7's `isVisible` contributions.

Why this is needed: `isVisible` predicates only receive `FluentResultGridCommandContext`, which today carries `selection` (ranges) but no column-count information. Determining "is this a full-row selection" or "is exactly one column selected" needs to know the total data column count, which isn't derivable from `selection` alone. This mirrors the existing `column?: IDbColumn` single-column field already on the context — it's a small, targeted addition of the same kind.

- [ ] **Step 1: Add the field to the context type**

In `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommands.ts`, add to `FluentResultGridCommandContext`:

```typescript
export interface FluentResultGridCommandContext
    extends FluentResultGridResultIdentity,
        FluentResultGridSelectionContext,
        FluentResultGridColumnContext {
    cell?: FluentResultGridCellContext;
    viewMode?: FluentResultGridViewMode;
    canToggleViewMode?: boolean;
    canToggleMaximize?: boolean;
    isMaximized?: boolean;
    isColumnFrozen?: boolean;
    dataColumnCount?: number;
}
```

- [ ] **Step 2: Populate it where the context is built**

In `extensions/mssql/src/webviews/common/FluentResultGrid/internal/useFluentResultGridController.ts`, update the `commandContext` memo:

```typescript
const commandContext = useMemo(
    () => ({
        gridId,
        batchId: resultSetSummary.batchId,
        resultId: resultSetSummary.id,
        viewMode,
        canToggleViewMode,
        canToggleMaximize,
        isMaximized,
        dataColumnCount: resultSetSummary.columnInfo.length,
        selection:
            reactGridRef.current?.slickGrid &&
            getDisplayedFluentResultGridSelectionForCopy(
                reactGridRef.current.slickGrid,
                reactGridRef.current.slickGrid.getDataLength(),
            ),
    }),
    [
        canToggleMaximize,
        canToggleViewMode,
        gridId,
        isMaximized,
        resultSetSummary.batchId,
        resultSetSummary.columnInfo.length,
        resultSetSummary.id,
        viewMode,
    ],
);
```

(The per-open context-menu override in `fluentResultGridCommandController.ts`'s `handleContextMenu` spreads `...commandContext` before overriding `selection`, so it inherits `dataColumnCount` automatically — no change needed there.)

- [ ] **Step 3: Verify no regressions**

Run: `cd extensions/mssql && npm test -- --grep "Fluent Result Grid"`
Expected: PASS — this is an additive field, no existing test asserts an exact shape of `commandContext` that would break (verify by reading test failures if any appear; if a test does a `deep.equal` on the full context object, add `dataColumnCount` to its expected value rather than removing the assertion).

- [ ] **Step 4: Commit**

```bash
git add extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridCommands.ts extensions/mssql/src/webviews/common/FluentResultGrid/internal/useFluentResultGridController.ts
git commit -m "feat: expose dataColumnCount on Fluent command context"
```

---

### Task 4: `fluentGenerateQuery.ts` — column adapter + shape-gating predicates

**Files:**

- Create: `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts`
- Test: `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts`

**Interfaces:**

- Consumes: `GeneratorColumn`, `isSingleRowSelection`, `isFullRowSelected`, `isSingleColumnMultiRowSelection` from `sqlScriptGenerator.ts` (Task 1).
- Produces: `buildGeneratorColumnsFromColumnInfo(columnInfo: IDbColumn[]): GeneratorColumn[]`, `isFluentGenerateRowActionsVisible(ranges: ISlickRange[], dataColumnCount: number): boolean`, `isFluentGenerateInsertVisible(ranges: ISlickRange[], dataColumnCount: number): boolean` — consumed by Task 5 and Task 7.

Why `dataColumnCount` and not real columns for the visibility predicates: `isVisible` only has the context built in Task 3, which carries a count, not full column metadata (names/tooltips are irrelevant to shape gating — only "is this a data column" matters, and every synthesized column here always is one).

- [ ] **Step 1: Write the failing tests**

Create `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect } from "chai";
import type { IDbColumn } from "vscode-mssql";
import type { ISlickRange } from "../../../src/sharedInterfaces/queryResult";
import {
    buildGeneratorColumnsFromColumnInfo,
    isFluentGenerateInsertVisible,
    isFluentGenerateRowActionsVisible,
} from "../../../src/webviews/pages/QueryResult/fluentGenerateQuery";

function makeDbCol(columnName: string): IDbColumn {
    return { columnName } as IDbColumn;
}

function makeRange(fromRow: number, toRow: number, fromCell: number, toCell: number): ISlickRange {
    return { fromRow, toRow, fromCell, toCell };
}

suite("fluentGenerateQuery", () => {
    suite("buildGeneratorColumnsFromColumnInfo", () => {
        test("builds one column per columnInfo entry, keyed by data index", () => {
            const columns = buildGeneratorColumnsFromColumnInfo([
                makeDbCol("Id"),
                makeDbCol("Name"),
            ]);
            expect(columns).to.deep.equal([
                { id: "0", field: "0", name: "Id", toolTip: "Id" },
                { id: "1", field: "1", name: "Name", toolTip: "Name" },
            ]);
        });
    });

    suite("isFluentGenerateRowActionsVisible", () => {
        test("true for a partial single-row selection", () => {
            expect(isFluentGenerateRowActionsVisible([makeRange(0, 0, 0, 0)], 3)).to.equal(true);
        });

        test("false for a full-row single selection", () => {
            expect(isFluentGenerateRowActionsVisible([makeRange(0, 0, 0, 2)], 3)).to.equal(false);
        });

        test("true for a multi-row single-column selection", () => {
            expect(isFluentGenerateRowActionsVisible([makeRange(0, 2, 1, 1)], 3)).to.equal(true);
        });

        test("false for a multi-row multi-column selection", () => {
            expect(isFluentGenerateRowActionsVisible([makeRange(0, 2, 0, 1)], 3)).to.equal(false);
        });

        test("false for an empty selection", () => {
            expect(isFluentGenerateRowActionsVisible([], 3)).to.equal(false);
        });
    });

    suite("isFluentGenerateInsertVisible", () => {
        test("true for a full-row single selection", () => {
            expect(isFluentGenerateInsertVisible([makeRange(0, 0, 0, 2)], 3)).to.equal(true);
        });

        test("false for a partial single-row selection", () => {
            expect(isFluentGenerateInsertVisible([makeRange(0, 0, 0, 1)], 3)).to.equal(false);
        });

        test("false for a multi-row selection", () => {
            expect(isFluentGenerateInsertVisible([makeRange(0, 1, 0, 2)], 3)).to.equal(false);
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/mssql && npm test -- --grep fluentGenerateQuery`
Expected: FAIL — `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDbColumn, ISlickRange } from "../../../sharedInterfaces/queryResult";
import {
    isFullRowSelected,
    isSingleColumnMultiRowSelection,
    isSingleRowSelection,
    type GeneratorColumn,
} from "../../common/sqlScriptGenerator";

export function buildGeneratorColumnsFromColumnInfo(columnInfo: IDbColumn[]): GeneratorColumn[] {
    return columnInfo.map((info, index) => ({
        id: index.toString(),
        field: index.toString(),
        name: info.columnName,
        toolTip: info.columnName,
    }));
}

function buildPlaceholderColumns(dataColumnCount: number): GeneratorColumn[] {
    return Array.from({ length: dataColumnCount }, (_, index) => ({
        id: index.toString(),
        field: index.toString(),
    }));
}

export function isFluentGenerateRowActionsVisible(
    ranges: ISlickRange[],
    dataColumnCount: number,
): boolean {
    if (ranges.length === 0) {
        return false;
    }
    const columns = buildPlaceholderColumns(dataColumnCount);
    return (
        (isSingleRowSelection(ranges) && !isFullRowSelected(ranges, columns)) ||
        isSingleColumnMultiRowSelection(ranges, columns)
    );
}

export function isFluentGenerateInsertVisible(
    ranges: ISlickRange[],
    dataColumnCount: number,
): boolean {
    if (ranges.length === 0) {
        return false;
    }
    const columns = buildPlaceholderColumns(dataColumnCount);
    return isSingleRowSelection(ranges) && isFullRowSelected(ranges, columns);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extensions/mssql && npm test -- --grep fluentGenerateQuery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts
git commit -m "feat: add Fluent grid Generate column adapter and shape-gating predicates"
```

---

### Task 5: `fluentGenerateQuery.ts` — SQL resolution + command orchestrator

**Files:**

- Modify: `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts`
- Modify: `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts`

**Interfaces:**

- Consumes: `generateSelect/generateUpdate/generateDelete/generateInsertForRows/generateSelectIn/generateUpdateIn/generateDeleteIn`, `getSelectedColumnIndices`, `GeneratorDataProvider`, `FallbackTableName` from `sqlScriptGenerator.ts` (Task 1); `buildGeneratorColumnsFromColumnInfo` (Task 4).
- Produces: `FluentGenerateAction = "select" | "update" | "delete" | "insert"`, `resolveFluentGeneratedSql(action, ranges, columnInfo, rowAccessor, fallback?): string | undefined`, `dispatchFluentGenerateCommand(options): Promise<void>` — consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts` (add the new imports to the existing import block, then add these suites before the closing `});` of `suite("fluentGenerateQuery", ...)`):

```typescript
    dispatchFluentGenerateCommand,
    resolveFluentGeneratedSql,
    type FluentGenerateAction,
```

(add to the existing `import { ... } from "../../../src/webviews/pages/QueryResult/fluentGenerateQuery";` list)

```typescript
import type { GeneratorDataProvider } from "../../../src/webviews/common/sqlScriptGenerator";
```

(add as a new import line)

```typescript
suite("resolveFluentGeneratedSql", () => {
    const columnInfo = [
        {
            columnName: "Id",
            baseColumnName: "Id",
            baseTableName: "Customers",
            baseSchemaName: "dbo",
        } as IDbColumn,
        {
            columnName: "Name",
            baseColumnName: "Name",
            baseTableName: "Customers",
            baseSchemaName: "dbo",
        } as IDbColumn,
    ];
    const singleRowProvider: GeneratorDataProvider = {
        getItem: (row: number) =>
            row === 0
                ? {
                      "0": { displayValue: "1", isNull: false },
                      "1": { displayValue: "Alice", isNull: false },
                  }
                : {},
    };
    const multiRowProvider: GeneratorDataProvider = {
        getItem: (row: number) =>
            (
                [
                    {
                        "0": { displayValue: "1", isNull: false },
                        "1": { displayValue: "Alice", isNull: false },
                    },
                    {
                        "0": { displayValue: "2", isNull: false },
                        "1": { displayValue: "Bob", isNull: false },
                    },
                ] as Record<string, { displayValue: string; isNull: boolean }>[]
            )[row] ?? {},
    };

    test("generates a single-row SELECT for a partial single-row selection", () => {
        const sql = resolveFluentGeneratedSql(
            "select",
            [{ fromRow: 0, toRow: 0, fromCell: 0, toCell: 0 }],
            columnInfo,
            singleRowProvider,
        );
        expect(sql).to.equal("SELECT [Id], [Name]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] = 1;");
    });

    test("generates a full-row INSERT for a full-row single selection", () => {
        const sql = resolveFluentGeneratedSql(
            "insert",
            [{ fromRow: 0, toRow: 0, fromCell: 0, toCell: 1 }],
            columnInfo,
            singleRowProvider,
        );
        expect(sql).to.equal(
            "INSERT INTO [dbo].[Customers] ([Id], [Name])\r\nVALUES\r\n    (1, 'Alice');",
        );
    });

    test("generates a WHERE...IN DELETE for a multi-row single-column selection", () => {
        const sql = resolveFluentGeneratedSql(
            "delete",
            [{ fromRow: 0, toRow: 1, fromCell: 0, toCell: 0 }],
            columnInfo,
            multiRowProvider,
        );
        expect(sql).to.equal("DELETE FROM [dbo].[Customers]\r\nWHERE [Id] IN (1, 2);");
    });

    test("returns undefined for an unsupported multi-row multi-column selection", () => {
        const sql = resolveFluentGeneratedSql(
            "select",
            [{ fromRow: 0, toRow: 1, fromCell: 0, toCell: 1 }],
            columnInfo,
            multiRowProvider,
        );
        expect(sql).to.equal(undefined);
    });

    test("returns undefined for insert on a multi-row single-column selection", () => {
        const sql = resolveFluentGeneratedSql(
            "insert",
            [{ fromRow: 0, toRow: 1, fromCell: 0, toCell: 0 }],
            columnInfo,
            multiRowProvider,
        );
        expect(sql).to.equal(undefined);
    });
});

suite("dispatchFluentGenerateCommand", () => {
    const columnInfo = [
        {
            columnName: "Id",
            baseColumnName: "Id",
            baseTableName: "Customers",
            baseSchemaName: "dbo",
        } as IDbColumn,
    ];
    const provider: GeneratorDataProvider = {
        getItem: () => ({ "0": { displayValue: "1", isNull: false } }),
    };

    test("resolves the table name, generates SQL, and opens it", async () => {
        const openedSql: string[] = [];
        const warnings: string[] = [];

        await dispatchFluentGenerateCommand({
            action: "select",
            ranges: [{ fromRow: 0, toRow: 0, fromCell: 0, toCell: 0 }],
            columnInfo,
            rowAccessor: provider,
            resolveTableName: async () => ({ tableName: undefined, schemaName: undefined }),
            openGeneratedQuery: async (sql) => {
                openedSql.push(sql);
            },
            warn: (message) => warnings.push(message),
        });

        expect(openedSql).to.deep.equal([
            "SELECT [Id]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] = 1;",
        ]);
        expect(warnings).to.deep.equal([]);
    });

    test("warns instead of opening when no SQL can be generated", async () => {
        const openedSql: string[] = [];
        const warnings: string[] = [];

        await dispatchFluentGenerateCommand({
            action: "select",
            ranges: [{ fromRow: 0, toRow: 1, fromCell: 0, toCell: 1 }],
            columnInfo: [{ columnName: "Id" } as IDbColumn, { columnName: "Name" } as IDbColumn],
            rowAccessor: provider,
            resolveTableName: async () => ({ tableName: undefined, schemaName: undefined }),
            openGeneratedQuery: async (sql) => {
                openedSql.push(sql);
            },
            warn: (message) => warnings.push(message),
        });

        expect(openedSql).to.deep.equal([]);
        expect(warnings.length).to.equal(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/mssql && npm test -- --grep fluentGenerateQuery`
Expected: FAIL — `resolveFluentGeneratedSql`/`dispatchFluentGenerateCommand` don't exist yet.

- [ ] **Step 3: Implement**

Append to `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts` (extend the existing imports first):

```typescript
import type { FallbackTableName, GeneratorDataProvider } from "../../common/sqlScriptGenerator";
import {
    generateDelete,
    generateDeleteIn,
    generateInsertForRows,
    generateSelect,
    generateSelectIn,
    generateUpdate,
    generateUpdateIn,
    getSelectedColumnIndices,
    isFullRowSelected,
    isSingleColumnMultiRowSelection,
    isSingleRowSelection,
    type GeneratorColumn,
} from "../../common/sqlScriptGenerator";
```

(merge with the existing import from `sqlScriptGenerator` rather than duplicating it — one import statement pulling all of these names.)

Then append:

```typescript
export type FluentGenerateAction = "select" | "update" | "delete" | "insert";

export function resolveFluentGeneratedSql(
    action: FluentGenerateAction,
    ranges: ISlickRange[],
    columnInfo: IDbColumn[],
    rowAccessor: GeneratorDataProvider,
    fallback?: FallbackTableName,
): string | undefined {
    const columns = buildGeneratorColumnsFromColumnInfo(columnInfo);
    const isSingleRow = isSingleRowSelection(ranges);
    const isMultiRowSingleColumn =
        action !== "insert" && isSingleColumnMultiRowSelection(ranges, columns);

    if (!isSingleRow && !isMultiRowSingleColumn) {
        return undefined;
    }

    if (isSingleRow) {
        const [range] = ranges;
        const row = range.fromRow;
        const selectedColumnIndices = getSelectedColumnIndices([range], columns);
        const isFullRow = isFullRowSelected(ranges, columns);

        switch (action) {
            case "select":
                return isFullRow
                    ? undefined
                    : generateSelect(
                          row,
                          selectedColumnIndices,
                          columns,
                          rowAccessor,
                          columnInfo,
                          fallback,
                      );
            case "update":
                return isFullRow
                    ? undefined
                    : generateUpdate(
                          row,
                          selectedColumnIndices,
                          columns,
                          rowAccessor,
                          columnInfo,
                          fallback,
                      );
            case "delete":
                return isFullRow
                    ? undefined
                    : generateDelete(
                          row,
                          selectedColumnIndices,
                          columns,
                          rowAccessor,
                          columnInfo,
                          fallback,
                      );
            case "insert":
                return isFullRow
                    ? generateInsertForRows(ranges, columns, rowAccessor, columnInfo, fallback)
                    : undefined;
        }
    }

    switch (action) {
        case "select":
            return generateSelectIn(ranges, columns, rowAccessor, columnInfo, fallback);
        case "update":
            return generateUpdateIn(ranges, columns, rowAccessor, columnInfo, fallback);
        case "delete":
            return generateDeleteIn(ranges, columns, rowAccessor, columnInfo, fallback);
        default:
            return undefined;
    }
}

export interface DispatchFluentGenerateCommandOptions {
    action: FluentGenerateAction;
    ranges: ISlickRange[];
    columnInfo: IDbColumn[];
    rowAccessor: GeneratorDataProvider;
    resolveTableName: () => Promise<{ tableName?: string; schemaName?: string }>;
    openGeneratedQuery: (sql: string) => Promise<void>;
    warn: (message: string) => void;
}

export async function dispatchFluentGenerateCommand({
    action,
    ranges,
    columnInfo,
    rowAccessor,
    resolveTableName,
    openGeneratedQuery,
    warn,
}: DispatchFluentGenerateCommandOptions): Promise<void> {
    const resolved = await resolveTableName();
    const fallback = resolved.tableName
        ? { tableName: resolved.tableName, schemaName: resolved.schemaName }
        : undefined;

    const sql = resolveFluentGeneratedSql(action, ranges, columnInfo, rowAccessor, fallback);
    if (!sql) {
        warn("Generate query action produced no SQL for the current selection");
        return;
    }

    await openGeneratedQuery(sql);
}
```

Note the unused `GeneratorColumn` import from the Task 4 step is still used by `buildPlaceholderColumns`/`buildGeneratorColumnsFromColumnInfo` already in the file — don't duplicate the import, merge into one `import { ... } from "../../common/sqlScriptGenerator";` statement combining Task 4's and this task's names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extensions/mssql && npm test -- --grep fluentGenerateQuery`
Expected: PASS, all `fluentGenerateQuery` tests green.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts
git commit -m "feat: add Fluent grid Generate SQL resolution and command orchestrator"
```

---

### Task 6: Thread a row accessor through Fluent's command dispatch

**Files:**

- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridProps.ts`
- Modify: `extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts`

**Interfaces:**

- Produces: `FluentResultGridProps.onCommand`'s new 2nd parameter, `rowAccessor: GeneratorDataProvider` — consumed by Task 7.

- [ ] **Step 1: Extend the `onCommand` prop type**

In `extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridProps.ts`, find the existing `onCommand?: (event: FluentResultGridCommandEvent) => MaybePromise<void>;` line and replace it with:

```typescript
    onCommand?: (
        event: FluentResultGridCommandEvent,
        rowAccessor: { getItem(row: number): Slick.SlickData },
    ) => MaybePromise<void>;
```

- [ ] **Step 2: Pass the row accessor through `emitHostCommand`**

In `extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts`, replace:

```typescript
const emitHostCommand = useCallback(
    async (grid: SlickGrid, event: FluentResultGridCommandEvent): Promise<void> => {
        const liveSelection = getSelectionForCommand(grid, event.commandId);
        await onCommand?.({
            ...event,
            selection: liveSelection ?? event.selection,
        });
    },
    [getSelectionForCommand, onCommand],
);
```

with:

```typescript
const emitHostCommand = useCallback(
    async (grid: SlickGrid, event: FluentResultGridCommandEvent): Promise<void> => {
        const liveSelection = getSelectionForCommand(grid, event.commandId);
        await onCommand?.(
            {
                ...event,
                selection: liveSelection ?? event.selection,
            },
            { getItem: (row: number) => grid.getDataItem(row) as Slick.SlickData },
        );
    },
    [getSelectionForCommand, onCommand],
);
```

- [ ] **Step 3: Verify no regressions**

Run: `cd extensions/mssql && npm test -- --grep "Fluent Result Grid"`
Expected: PASS — this is additive (extra callback argument); existing single-argument `onCommand` stubs in tests still work since JS ignores extra call arguments they don't declare.

Run: `cd extensions/mssql && npm run compile` (or the typecheck script)
Expected: no new type errors — `queryResultFluentResultGrid.tsx`'s `handleCommand` still compiles because a function with fewer declared parameters than the callback type's parameter list is assignable to that callback type in TypeScript (until Task 7 updates its signature to actually use the new parameter).

- [ ] **Step 4: Commit**

```bash
git add extensions/mssql/src/webviews/common/FluentResultGrid/types/fluentResultGridProps.ts extensions/mssql/src/webviews/common/FluentResultGrid/internal/fluentResultGridCommandController.ts
git commit -m "feat: thread a row accessor through Fluent grid command dispatch"
```

---

### Task 7: Wire the 4 commands into the Fluent Query Result grid

**Files:**

- Modify: `extensions/mssql/src/webviews/pages/QueryResult/queryResultFluentResultGrid.tsx`

**Interfaces:**

- Consumes: `FluentResultGridCommand.GenerateSelect/Update/Delete/Insert` (Task 2), `isFluentGenerateRowActionsVisible`/`isFluentGenerateInsertVisible` (Task 4), `dispatchFluentGenerateCommand` (Task 5), the `rowAccessor` 2nd param of `onCommand` (Task 6).

- [ ] **Step 1: Add imports**

In `extensions/mssql/src/webviews/pages/QueryResult/queryResultFluentResultGrid.tsx`, add:

```typescript
import {
    dispatchFluentGenerateCommand,
    isFluentGenerateInsertVisible,
    isFluentGenerateRowActionsVisible,
} from "./fluentGenerateQuery";
```

- [ ] **Step 2: Contribute the 4 new commands**

In `getQueryResultFluentGridCommandConfiguration()`, add after the `CopyAsInsertInto` contribution:

```typescript
            {
                id: FluentResultGridCommand.GenerateSelect,
                label: "",
                placements: [placement.CellContextMenu],
                groupId: "generate",
                order: 270,
                isVisible: (context) =>
                    isFluentGenerateRowActionsVisible(
                        [...(context.selection ?? [])],
                        context.dataColumnCount ?? 0,
                    ),
            },
            {
                id: FluentResultGridCommand.GenerateUpdate,
                label: "",
                placements: [placement.CellContextMenu],
                groupId: "generate",
                order: 280,
                isVisible: (context) =>
                    isFluentGenerateRowActionsVisible(
                        [...(context.selection ?? [])],
                        context.dataColumnCount ?? 0,
                    ),
            },
            {
                id: FluentResultGridCommand.GenerateDelete,
                label: "",
                placements: [placement.CellContextMenu],
                groupId: "generate",
                order: 290,
                isVisible: (context) =>
                    isFluentGenerateRowActionsVisible(
                        [...(context.selection ?? [])],
                        context.dataColumnCount ?? 0,
                    ),
            },
            {
                id: FluentResultGridCommand.GenerateInsert,
                label: "",
                placements: [placement.CellContextMenu],
                groupId: "generate",
                order: 300,
                isVisible: (context) =>
                    isFluentGenerateInsertVisible(
                        [...(context.selection ?? [])],
                        context.dataColumnCount ?? 0,
                    ),
            },
```

(`label: ""` matches the existing convention in this file — actual labels/icons are resolved elsewhere via `strings`, same as every other contribution here.)

- [ ] **Step 3: Add the dispatch case in `handleCommand`**

Update `handleCommand`'s signature and top-of-function guard, then add the new `case` block. Replace:

```typescript
    const handleCommand = useCallback(
        async (event: FluentResultGridCommandEvent) => {
            if (!context || !uri) {
                return;
            }

            const selection = [...(event.selection ?? [])];
            switch (event.commandId) {
```

with:

```typescript
    const handleCommand = useCallback(
        async (
            event: FluentResultGridCommandEvent,
            rowAccessor: { getItem(row: number): Slick.SlickData },
        ) => {
            if (!context || !uri) {
                return;
            }

            const selection = [...(event.selection ?? [])];
            switch (event.commandId) {
                case FluentResultGridCommand.GenerateSelect:
                case FluentResultGridCommand.GenerateUpdate:
                case FluentResultGridCommand.GenerateDelete:
                case FluentResultGridCommand.GenerateInsert: {
                    if (!resultSetSummary) {
                        break;
                    }
                    const action =
                        event.commandId === FluentResultGridCommand.GenerateSelect
                            ? "select"
                            : event.commandId === FluentResultGridCommand.GenerateUpdate
                              ? "update"
                              : event.commandId === FluentResultGridCommand.GenerateDelete
                                ? "delete"
                                : "insert";
                    await dispatchFluentGenerateCommand({
                        action,
                        ranges: selection,
                        columnInfo: resultSetSummary.columnInfo,
                        rowAccessor,
                        resolveTableName: async () => {
                            const resolved = await context.extensionRpc.sendRequest(
                                qr.ResolveTableNameRequest.type,
                                { uri, batchId: event.batchId },
                            );
                            return resolved;
                        },
                        openGeneratedQuery: async (sql) => {
                            await context.extensionRpc.sendRequest(qr.OpenGeneratedQueryRequest.type, {
                                uri,
                                sql,
                            });
                        },
                        warn: (message) => context.log.warn(message),
                    });
                    break;
                }
```

Then, further down, update the `useCallback` dependency array (currently `[context, props, uri]`) to include `resultSetSummary`:

```typescript
        [context, props, resultSetSummary, uri],
```

- [ ] **Step 4: Rebuild and verify**

Run: `cd extensions/mssql && npm run compile` (or typecheck script)
Expected: no type errors.

Run: `cd extensions/mssql && npm test`
Expected: full suite PASS, no regressions.

- [ ] **Step 5: Manual F5 verification**

1. Rebuild the webview bundle first — it is NOT auto-rebuilt on F5 launch: `cd extensions/mssql && npm run build:webviews-bundle`.
2. Launch the Extension Development Host (F5).
3. Enable the Fluent grid: set `mssql.previewFeatures.betaResultsGrid` to `true` in settings.
4. Run a query returning several rows, e.g. `SELECT * FROM dbo.SomeTable`.
5. Right-click a single cell (partial row selection) → confirm Generate SELECT/UPDATE/DELETE appear, Generate INSERT does not.
6. Select an entire row (click the row-number column, or select all data cells in one row) → confirm only Generate INSERT appears.
7. Generate SELECT on a single-row selection → confirm correct SQL, real table name, opens as a new query.
8. Drag-select multiple rows in a single column → confirm Generate SELECT/UPDATE/DELETE appear (not INSERT), and generate a `WHERE ... IN (...)` clause with real values.
9. Select cells spanning multiple rows and multiple columns → confirm no Generate commands appear.

- [ ] **Step 6: Commit**

```bash
git add extensions/mssql/src/webviews/pages/QueryResult/queryResultFluentResultGrid.tsx
git commit -m "feat: wire Generate SELECT/UPDATE/DELETE/INSERT into the Fluent results grid"
```

---

## Self-Review Notes

- **Spec coverage:** full parity scope (single-row SELECT/UPDATE/DELETE, full-row INSERT, table-name fallback, WHERE...IN) — covered by Task 5's `resolveFluentGeneratedSql` reusing all 7 `sqlScriptGenerator.ts` generate functions, and Task 7's dispatch wiring. `isVisible` shape gating (Task 4/7) matches legacy's `showRowActions`/`showInsertAction` exclusivity exactly (row actions XOR insert, never both). `CopyAsInClause`/`CopyAsInsertInto`'s missing `isVisible` gating is explicitly left untouched (no task modifies their contributions). SQL Tools Service / `copyResults2` is untouched (no task references `queryRunner.ts`).
- **Type consistency:** `GeneratorColumn`/`GeneratorDataProvider` (Task 1) are the single shared vocabulary used unchanged through Tasks 4–6; `FluentGenerateAction` (Task 5) string literals (`"select"/"update"/"delete"/"insert"`) are computed once in Task 7's `handleCommand` and passed straight through, no renaming across tasks.
- **Risk containment:** Task 1 is verified as behavior-neutral (existing test suite must show identical pass count) before any Fluent-side code depends on it. Tasks 2–6 each have their own automated test or explicit compile/regression check before Task 7 assembles them; Task 7 itself is thin wiring plus a manual F5 pass, consistent with the fact that this file has no existing component-level test harness.
