# Grid Generate WHERE...IN for Multi-Row Single-Column Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user selects multiple rows in exactly one grid column and picks Generate SELECT/UPDATE/DELETE, generate a `WHERE <col> IN (v1, v2, ...)` clause over the selected values instead of requiring a single-row selection.

**Architecture:** Add a new selection-shape helper (`isSingleColumnMultiRowSelection`) and three new pure generation functions (`generateSelectIn`/`generateUpdateIn`/`generateDeleteIn`) to `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`, alongside the existing single-row generators. Wire them into `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`'s existing Generate SELECT/UPDATE/DELETE menu items — no new menu items, no `GridContextMenu.tsx` changes (it already gates those three items behind one `showRowActions` boolean; this plan widens when that boolean is true). Generate INSERT is untouched and stays single-row/full-row only.

**Tech Stack:** TypeScript, mocha/chai (`vscode-test` unit test harness), sinon (for the context-menu dispatch tests).

**Base branch:** `feature/grid-query-table-name-fallback` (not `main`) — that branch has the current, already-merged-in-this-session state of both files this plan touches (the `FallbackTableName`/`fallback` plumbing and the `ResolveTableNameRequest` RPC call). Branching from `main` would miss that code entirely and every diff below would fail to apply.

## Global Constraints

- Multi-row selection triggers the IN-clause behavior **only when exactly one column is selected** (not multi-column). Multi-column-multi-row selections remain unsupported (fall through to the existing "no-op + warn" path).
- NULL cells in the selected column are **silently dropped** from the IN list (not `OR col IS NULL`).
- Duplicate values in the selected column are **de-duplicated** in the IN list.
- If every selected value is NULL, the generator returns `undefined` (no SQL) rather than emitting invalid `IN ()` — the caller must treat this the same as the existing "invalid selection" no-op-and-warn path.
- Generate UPDATE for this shape emits **no real SET clause** — just `SET /* TODO: specify columns and values to update */` — because there is no single "other columns" row to copy values from.
- Generate INSERT is **not** available for this selection shape (menu never shows it here; dispatch code must not attempt it even if triggered defensively).
- Existing single-row Generate SELECT/UPDATE/DELETE/INSERT behavior must be completely unchanged for single-row selections.

---

## File Structure

- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts` — add `isSingleColumnMultiRowSelection`, `buildInClause` (+ private `getSelectedRows`, `buildInClauseValues`, `getColumnPairsForRows` helpers), `generateSelectIn`, `generateDeleteIn`, `generateUpdateIn`.
- Modify: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts` — tests for all of the above.
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts` — widen `showRowActions` gating in `handleContextMenu`, and branch the Generate SELECT/UPDATE/DELETE dispatch in `handleMenuAction` on selection shape.
- Modify: `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts` — update the one existing test whose selection shape (2 rows, 1 column) is now valid under the new feature instead of invalid, and add new tests for the IN-clause dispatch path.

---

### Task 1: `sqlScriptGenerator.ts` — IN-clause generation

**Files:**

- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`
- Test: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`

**Interfaces:**

- Produces: `isSingleColumnMultiRowSelection<T>(ranges: ISlickRange[], columns: Slick.Column<T>[]): boolean`, `buildInClause<T>(pairs: ColumnValuePair<T>[]): string | undefined`, `generateSelectIn<T>(ranges, columns, dataProvider, columnInfo, fallback?): string | undefined`, `generateDeleteIn<T>(ranges, columns, dataProvider, columnInfo, fallback?): string | undefined`, `generateUpdateIn<T>(ranges, columns, dataProvider, columnInfo, fallback?): string | undefined` — all used by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`. First, add the two new imports to the existing import block at the top of the file (alongside `buildQualifiedTableName`, `generateDelete`, etc.):

```typescript
    buildInClause,
    generateDeleteIn,
    generateSelectIn,
    generateUpdateIn,
    isSingleColumnMultiRowSelection,
```

Then add these two new `suite(...)` blocks right after the existing `suite("generateInsertForRows", ...)` block (i.e. just before the final closing `});` of the outer `suite("sqlScriptGenerator", ...)`):

```typescript
suite("isSingleColumnMultiRowSelection", () => {
    const cols = [makeCol(0, "Id"), makeCol(1, "Name")];

    test("true for two rows in the same single column", () => {
        const ranges = [makeRange(0, 2, 0, 0)];
        expect(isSingleColumnMultiRowSelection(ranges, cols)).to.equal(true);
    });

    test("true for two discontiguous single-cell ranges in the same column", () => {
        const ranges = [makeRange(0, 0, 0, 0), makeRange(2, 2, 0, 0)];
        expect(isSingleColumnMultiRowSelection(ranges, cols)).to.equal(true);
    });

    test("false when the selection spans more than one column", () => {
        const ranges = [makeRange(0, 2, 0, 1)];
        expect(isSingleColumnMultiRowSelection(ranges, cols)).to.equal(false);
    });

    test("false for a single-row, single-column selection", () => {
        const ranges = [makeRange(0, 0, 0, 0)];
        expect(isSingleColumnMultiRowSelection(ranges, cols)).to.equal(false);
    });
});

suite("generateSelectIn / generateUpdateIn / generateDeleteIn", () => {
    const columnInfo = [
        makeDbCol("int", "Id", "Customers", "dbo"),
        makeDbCol("nvarchar", "Name", "Customers", "dbo"),
    ];
    const cols = [makeCol(0, "Id"), makeCol(1, "Name")];
    const rows: CellRow[] = [
        { "0": makeCell("1"), "1": makeCell("Alice") },
        { "0": makeCell("2"), "1": makeCell("Bob") },
        { "0": makeCell("2"), "1": makeCell("Bob2") }, // duplicate Id value 2
        { "0": makeCell("", true), "1": makeCell("NullRow") }, // NULL Id
    ];

    test("generateSelectIn builds a deduped, NULL-dropped IN clause over the selected column", () => {
        const provider = makeProvider(rows);
        const ranges = [makeRange(0, 3, 0, 0)];
        const result = generateSelectIn(ranges, cols, provider, columnInfo);
        expect(result).to.equal(
            "SELECT [Id], [Name]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] IN (1, 2);",
        );
    });

    test("generateDeleteIn builds the same IN clause without selecting columns", () => {
        const provider = makeProvider(rows);
        const ranges = [makeRange(0, 3, 0, 0)];
        const result = generateDeleteIn(ranges, cols, provider, columnInfo);
        expect(result).to.equal("DELETE FROM [dbo].[Customers]\r\nWHERE [Id] IN (1, 2);");
    });

    test("generateUpdateIn emits a placeholder SET clause and the IN-based WHERE", () => {
        const provider = makeProvider(rows);
        const ranges = [makeRange(0, 3, 0, 0)];
        const result = generateUpdateIn(ranges, cols, provider, columnInfo);
        expect(result).to.equal(
            "UPDATE [dbo].[Customers]\r\nSET /* TODO: specify columns and values to update */\r\nWHERE [Id] IN (1, 2);",
        );
    });

    test("returns undefined when every selected value is NULL", () => {
        const nullRows: CellRow[] = [
            { "0": makeCell("", true), "1": makeCell("A") },
            { "0": makeCell("", true), "1": makeCell("B") },
        ];
        const provider = makeProvider(nullRows);
        const ranges = [makeRange(0, 1, 0, 0)];
        expect(generateSelectIn(ranges, cols, provider, columnInfo)).to.equal(undefined);
        expect(generateUpdateIn(ranges, cols, provider, columnInfo)).to.equal(undefined);
        expect(generateDeleteIn(ranges, cols, provider, columnInfo)).to.equal(undefined);
    });

    test("generateDeleteIn uses the fallback table name when baseTableName is empty", () => {
        const noTableColumnInfo = [makeDbCol("int"), makeDbCol("nvarchar")];
        const provider = makeProvider(rows);
        const ranges = [makeRange(0, 3, 0, 0)];
        const result = generateDeleteIn(ranges, cols, provider, noTableColumnInfo, {
            tableName: "Customers",
            schemaName: "dbo",
        });
        expect(result).to.equal("DELETE FROM [dbo].[Customers]\r\nWHERE [Id] IN (1, 2);");
    });
});
```

Also add a direct test for `buildInClause` in the existing `suite("buildQualifiedTableName", ...)`-adjacent area — add a new small suite right after it:

```typescript
suite("buildInClause", () => {
    test("returns undefined for an empty pair list", () => {
        expect(buildInClause([])).to.equal(undefined);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/mssql && npm test`
Expected: FAIL — compile error, since `isSingleColumnMultiRowSelection`, `buildInClause`, `generateSelectIn`, `generateDeleteIn`, `generateUpdateIn` don't exist yet in `sqlScriptGenerator.ts`.

- [ ] **Step 3: Implement the new helpers and generators**

In `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`, insert this new exported function right after `isFullRowSelected` (i.e. immediately after its closing `}` at line 101, before the `ColumnValuePair` interface):

```typescript
export function isSingleColumnMultiRowSelection<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
): boolean {
    return (
        getSelectedColumnIndices(ranges, columns).length === 1 && getSelectedRows(ranges).length > 1
    );
}
```

Immediately after `getRowPairs` (the private helper right before `export function generateSelect`), insert these three private helpers and one exported helper:

```typescript
function getSelectedRows(ranges: ISlickRange[]): number[] {
    const rows = new Set<number>();
    for (const range of ranges) {
        for (let r = range.fromRow; r <= range.toRow; r++) {
            rows.add(r);
        }
    }
    return [...rows].sort((a, b) => a - b);
}

function getColumnPairsForRows<T extends Slick.SlickData>(
    colIndex: number,
    rows: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
): ColumnValuePair<T>[] {
    return rows.map((r) => getColumnValuePair(colIndex, r, columns, dataProvider, columnInfo));
}

function buildInClauseValues<T extends Slick.SlickData>(pairs: ColumnValuePair<T>[]): string[] {
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

export function buildInClause<T extends Slick.SlickData>(
    pairs: ColumnValuePair<T>[],
): string | undefined {
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
```

Note `isSingleColumnMultiRowSelection` (placed earlier in the file) calls `getSelectedRows`, which is defined later — this is safe because both are top-level `function` declarations, which TypeScript/JS hoist within the module.

Finally, append these three exported functions at the very end of the file, after `generateInsertForRows`:

```typescript
export function generateSelectIn<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
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

export function generateDeleteIn<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
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

export function generateUpdateIn<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extensions/mssql && npm test`
Expected: PASS, all new and pre-existing `sqlScriptGenerator` tests green.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/common/sqlScriptGenerator.ts extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts
git commit -m "feat: add WHERE...IN generators for multi-row single-column selection"
```

---

### Task 2: `contextMenu.plugin.ts` — wire the IN-clause path into the Generate menu

**Files:**

- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`
- Test: `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`

**Interfaces:**

- Consumes: `isSingleColumnMultiRowSelection`, `generateSelectIn`, `generateDeleteIn`, `generateUpdateIn` (Task 1).

- [ ] **Step 1: Write/update the failing tests**

In `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`:

First, widen `makeGridAndContext` to accept an optional per-row data map (defaulting to today's behavior, so the two existing tests that call it with one argument are unaffected). Replace the current function (lines 86-101):

```typescript
function makeGridAndContext(
    selectedRanges: unknown[],
    rowsByIndex: Record<number, unknown> = { 0: row },
) {
    const grid = {
        getSelectionModel: () => ({ getSelectedRanges: () => selectedRanges }),
        getColumns: () => cols,
        getData: () => ({ getItem: (r: number) => rowsByIndex[r] ?? {} }),
    };
    const sendRequest = sandbox.stub().resolves({});
    const queryResultContext = {
        log: { trace: sandbox.stub(), warn: sandbox.stub() },
        extensionRpc: { sendRequest },
        showGridContextMenu: sandbox.stub(),
        hideGridContextMenu: sandbox.stub(),
        showCopyIndicator: sandbox.stub(),
    } as unknown as QueryResultReactProvider;
    return { grid, queryResultContext, sendRequest };
}
```

Second, the existing test `"does nothing and warns when the selection spans more than one row"` (lines 153-169) tests a selection shape — 2 rows, 1 column — that this plan makes VALID. Replace it so it tests a shape that is still invalid (2 rows, 2 columns):

```typescript
test("does nothing and warns when the selection spans multiple rows and multiple columns", async () => {
    const { grid, queryResultContext, sendRequest } = makeGridAndContext([makeRange(0, 1, 0, 1)]);
    const menu = new ContextMenu<Slick.SlickData>(
        "file:///test.sql",
        { batchId: 0, id: 0, rowCount: 2, columnInfo } as ResultSetSummary,
        queryResultContext,
    );
    menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
    await (
        menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
    ).handleMenuAction(GridContextMenuAction.GenerateSelect);

    expect(sendRequest.called).to.equal(false);
    expect((queryResultContext.log.warn as sinon.SinonStub).calledOnce).to.equal(true);
});
```

Third, add these four new tests right after it, before the suite's closing `});`:

```typescript
test("GenerateSelect builds a WHERE...IN clause when multiple rows in one column are selected", async () => {
    const { grid, queryResultContext, sendRequest } = makeGridAndContext([makeRange(0, 1, 0, 0)], {
        0: {
            "0": { displayValue: "1", isNull: false },
            "1": { displayValue: "Alice", isNull: false },
        },
        1: {
            "0": { displayValue: "2", isNull: false },
            "1": { displayValue: "Bob", isNull: false },
        },
    });
    const menu = new ContextMenu<Slick.SlickData>(
        "file:///test.sql",
        { batchId: 0, id: 0, rowCount: 2, columnInfo } as ResultSetSummary,
        queryResultContext,
    );
    menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
    await (
        menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
    ).handleMenuAction(GridContextMenuAction.GenerateSelect);

    const openCall = sendRequest
        .getCalls()
        .find((c) => c.args[0] === OpenGeneratedQueryRequest.type);
    expect(openCall).to.not.equal(undefined);
    const [, params] = openCall!.args;
    expect(params.sql).to.equal(
        "SELECT [Id], [Name]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] IN (1, 2);",
    );
});

test("GenerateDelete builds a WHERE...IN clause for a multi-row single-column selection", async () => {
    const { grid, queryResultContext, sendRequest } = makeGridAndContext([makeRange(0, 1, 0, 0)], {
        0: {
            "0": { displayValue: "1", isNull: false },
            "1": { displayValue: "Alice", isNull: false },
        },
        1: {
            "0": { displayValue: "2", isNull: false },
            "1": { displayValue: "Bob", isNull: false },
        },
    });
    const menu = new ContextMenu<Slick.SlickData>(
        "file:///test.sql",
        { batchId: 0, id: 0, rowCount: 2, columnInfo } as ResultSetSummary,
        queryResultContext,
    );
    menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
    await (
        menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
    ).handleMenuAction(GridContextMenuAction.GenerateDelete);

    const openCall = sendRequest
        .getCalls()
        .find((c) => c.args[0] === OpenGeneratedQueryRequest.type);
    expect(openCall).to.not.equal(undefined);
    const [, params] = openCall!.args;
    expect(params.sql).to.equal("DELETE FROM [dbo].[Customers]\r\nWHERE [Id] IN (1, 2);");
});

test("GenerateUpdate emits a placeholder SET clause with a WHERE...IN for a multi-row single-column selection", async () => {
    const { grid, queryResultContext, sendRequest } = makeGridAndContext([makeRange(0, 1, 0, 0)], {
        0: {
            "0": { displayValue: "1", isNull: false },
            "1": { displayValue: "Alice", isNull: false },
        },
        1: {
            "0": { displayValue: "2", isNull: false },
            "1": { displayValue: "Bob", isNull: false },
        },
    });
    const menu = new ContextMenu<Slick.SlickData>(
        "file:///test.sql",
        { batchId: 0, id: 0, rowCount: 2, columnInfo } as ResultSetSummary,
        queryResultContext,
    );
    menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
    await (
        menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
    ).handleMenuAction(GridContextMenuAction.GenerateUpdate);

    const openCall = sendRequest
        .getCalls()
        .find((c) => c.args[0] === OpenGeneratedQueryRequest.type);
    expect(openCall).to.not.equal(undefined);
    const [, params] = openCall!.args;
    expect(params.sql).to.equal(
        "UPDATE [dbo].[Customers]\r\nSET /* TODO: specify columns and values to update */\r\nWHERE [Id] IN (1, 2);",
    );
});

test("GenerateInsert still warns and does nothing for a multi-row single-column selection", async () => {
    const { grid, queryResultContext, sendRequest } = makeGridAndContext([makeRange(0, 1, 0, 0)], {
        0: {
            "0": { displayValue: "1", isNull: false },
            "1": { displayValue: "Alice", isNull: false },
        },
        1: {
            "0": { displayValue: "2", isNull: false },
            "1": { displayValue: "Bob", isNull: false },
        },
    });
    const menu = new ContextMenu<Slick.SlickData>(
        "file:///test.sql",
        { batchId: 0, id: 0, rowCount: 2, columnInfo } as ResultSetSummary,
        queryResultContext,
    );
    menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
    await (
        menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
    ).handleMenuAction(GridContextMenuAction.GenerateInsert);

    expect(sendRequest.called).to.equal(false);
    expect((queryResultContext.log.warn as sinon.SinonStub).calledOnce).to.equal(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/mssql && npm test`
Expected: FAIL — the renamed/reshaped "does nothing and warns" test now fails against the OLD code (old code would have warned for the (0,1,0,0) shape too, but this test uses (0,1,0,1) now, which is still correctly rejected by old code, so it should actually still pass; the four NEW tests fail because the old code warns-and-no-ops for any multi-row selection, so `sendRequest.called` stays `false` and no `OpenGeneratedQueryRequest` call exists to find).

- [ ] **Step 3: Implement the wiring**

In `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`, update the import block (lines 27-35) to:

```typescript
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
} from "../../../../common/sqlScriptGenerator";
```

In `handleContextMenu`, replace this block (current lines 78-94):

```typescript
const gridColumns = this.grid.getColumns();
const dataSelection = tryCombineSelections(this.grid.getSelectionModel().getSelectedRanges());
const isSingleRow = isSingleRowSelection(dataSelection);
const isFullRow = isSingleRow && isFullRowSelected(dataSelection, gridColumns);

// Ask outer React app to show menu at coordinates
this.queryResultContext.showGridContextMenu(
    adjustedX,
    adjustedY,
    async (action: GridContextMenuAction) => {
        await this.handleMenuAction(action);
        this.queryResultContext.hideGridContextMenu();
    },
    { showRowActions: isSingleRow && !isFullRow, showInsertAction: isFullRow },
);
```

with:

```typescript
const gridColumns = this.grid.getColumns();
const dataSelection = tryCombineSelections(this.grid.getSelectionModel().getSelectedRanges());
const isSingleRow = isSingleRowSelection(dataSelection);
const isFullRow = isSingleRow && isFullRowSelected(dataSelection, gridColumns);
const isMultiRowSingleColumn = isSingleColumnMultiRowSelection(dataSelection, gridColumns);

// Ask outer React app to show menu at coordinates
this.queryResultContext.showGridContextMenu(
    adjustedX,
    adjustedY,
    async (action: GridContextMenuAction) => {
        await this.handleMenuAction(action);
        this.queryResultContext.hideGridContextMenu();
    },
    {
        showRowActions: (isSingleRow && !isFullRow) || isMultiRowSingleColumn,
        showInsertAction: isFullRow,
    },
);
```

In `handleMenuAction`, replace the entire Generate case block (current lines 194-267) with:

```typescript
            case GridContextMenuAction.GenerateSelect:
            case GridContextMenuAction.GenerateUpdate:
            case GridContextMenuAction.GenerateDelete:
            case GridContextMenuAction.GenerateInsert: {
                log.trace(`${action} action triggered`);
                const gridColumns = this.grid.getColumns();
                const dataSelection = tryCombineSelections(
                    this.grid.getSelectionModel().getSelectedRanges(),
                );
                const dataProvider = this.grid.getData() as IDisposableDataProvider<T>;
                const columnInfo = this.resultSetSummary.columnInfo;

                const isSingleRow = isSingleRowSelection(dataSelection);
                const isMultiRowSingleColumn =
                    action !== GridContextMenuAction.GenerateInsert &&
                    isSingleColumnMultiRowSelection(dataSelection, gridColumns);

                if (!isSingleRow && !isMultiRowSingleColumn) {
                    log.warn(
                        "Generate query actions require a single-row or single-column selection",
                    );
                    break;
                }

                const resolved = await this.queryResultContext.extensionRpc.sendRequest(
                    ResolveTableNameRequest.type,
                    { uri: this.uri, batchId: this.resultSetSummary.batchId },
                );
                const fallback = resolved.tableName
                    ? { tableName: resolved.tableName, schemaName: resolved.schemaName }
                    : undefined;

                let sql: string | undefined;
                if (isSingleRow) {
                    const [range] = dataSelection;
                    const row = range.fromRow;
                    const selectedColumnIndices = getSelectedColumnIndices([range], gridColumns);
                    if (action === GridContextMenuAction.GenerateSelect) {
                        sql = generateSelect(
                            row,
                            selectedColumnIndices,
                            gridColumns,
                            dataProvider,
                            columnInfo,
                            fallback,
                        );
                    } else if (action === GridContextMenuAction.GenerateUpdate) {
                        sql = generateUpdate(
                            row,
                            selectedColumnIndices,
                            gridColumns,
                            dataProvider,
                            columnInfo,
                            fallback,
                        );
                    } else if (action === GridContextMenuAction.GenerateDelete) {
                        sql = generateDelete(
                            row,
                            selectedColumnIndices,
                            gridColumns,
                            dataProvider,
                            columnInfo,
                            fallback,
                        );
                    } else {
                        sql = generateInsertForRows(
                            [range],
                            gridColumns,
                            dataProvider,
                            columnInfo,
                            fallback,
                        );
                    }
                } else if (action === GridContextMenuAction.GenerateSelect) {
                    sql = generateSelectIn(
                        dataSelection,
                        gridColumns,
                        dataProvider,
                        columnInfo,
                        fallback,
                    );
                } else if (action === GridContextMenuAction.GenerateUpdate) {
                    sql = generateUpdateIn(
                        dataSelection,
                        gridColumns,
                        dataProvider,
                        columnInfo,
                        fallback,
                    );
                } else {
                    sql = generateDeleteIn(
                        dataSelection,
                        gridColumns,
                        dataProvider,
                        columnInfo,
                        fallback,
                    );
                }

                if (!sql) {
                    log.warn(
                        "Generate query action produced no SQL (e.g. every selected value was NULL)",
                    );
                    break;
                }

                await this.queryResultContext.extensionRpc.sendRequest(
                    OpenGeneratedQueryRequest.type,
                    {
                        uri: this.uri,
                        sql,
                    },
                );
                break;
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extensions/mssql && npm test`
Expected: PASS, all `contextMenu.plugin.test.ts` tests green (the reshaped multi-column test, the 4 new IN-path tests, and the two untouched pre-existing single-row tests), no regressions elsewhere.

- [ ] **Step 5: Manual verification**

In the Extension Development Host (F5), on the legacy results grid:

1. Run a query returning several rows, e.g. `SELECT * FROM dbo.SomeTable`.
2. Drag-select multiple rows in a single column (like the screenshot: click a cell, shift-click a cell several rows down, same column).
3. Right-click → confirm Generate SELECT/UPDATE/DELETE are offered (Generate INSERT should NOT be offered for this shape).
4. Generate SELECT → confirm `WHERE <col> IN (v1, v2, ...)` with the actual selected values, real table name.
5. Generate DELETE → same IN clause, no SELECT columns.
6. Generate UPDATE → confirm `SET /* TODO: ... */` placeholder and the same IN clause.
7. Ctrl+click to select several non-contiguous cells in one column, confirm the same behavior works (multi-range).
8. Select a NULL cell alongside non-NULL cells in the column, confirm the NULL value is silently absent from the IN list.
9. Select cells spanning multiple rows AND multiple columns — confirm the old "no-op, nothing happens" behavior (this shape stays unsupported).

- [ ] **Step 6: Commit**

```bash
git add extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts
git commit -m "feat: offer Generate SELECT/UPDATE/DELETE with WHERE...IN for multi-row single-column selections"
```

---

## Self-Review Notes

- **Spec coverage:** single-column-only scope (Task 1's `isSingleColumnMultiRowSelection` gate), NULL-dropping (`buildInClauseValues`), de-duplication (`Set` in `buildInClauseValues`), empty-list-returns-undefined (`buildInClause`), UPDATE placeholder SET (`generateUpdateIn`), INSERT excluded (Task 2's `action !== GridContextMenuAction.GenerateInsert` guard and the dedicated test for it) — all covered by a task and a test.
- **Behavior-change callout:** the pre-existing `contextMenu.plugin.test.ts` test for a (2 rows, 1 column) selection is being _repurposed_ to a (2 rows, 2 columns) selection, because the old shape becomes valid under this feature — this is flagged explicitly in Task 2 Step 1/2 so the implementer doesn't mistake the reshaped test for an accidental regression.
- **Type consistency:** `generateSelectIn`/`generateDeleteIn`/`generateUpdateIn` all return `string | undefined` (unlike the existing single-row generators, which always return `string`) — Task 2's dispatch code declares `sql: string | undefined` and checks `if (!sql)` before using it, consistent across both task's code.
- No STS/backend changes; this is entirely client-side generation logic, consistent with the rest of this feature area.
