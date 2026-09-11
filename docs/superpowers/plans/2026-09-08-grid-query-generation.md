# Grid SELECT/UPDATE/DELETE/INSERT Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click a cell/row selection in the legacy (default) Query Results grid and generate a ready-to-edit SELECT, UPDATE, DELETE, or INSERT statement in a new untitled SQL editor tab, using the selected column/value pairs — without hand-typing WHERE clauses. Also fix the "TableName" literal-placeholder bug in the Notebook Renderer's existing "Copy as INSERT INTO" while touching the same code.

**Architecture:** All SQL text generation happens entirely client-side in the webview, reusing/extracting the logic that already exists in `notebookContextMenu.plugin.ts`'s `formatAsInsertInto` into a new shared, framework-agnostic module (`webviews/common/sqlScriptGenerator.ts`). The legacy grid's `ContextMenu` class (`table/plugins/contextMenu.plugin.ts`) calls into that module to build a SQL string, then sends **one** new RPC request (`OpenGeneratedQueryRequest`) carrying the finished SQL string to the extension host, which opens it in a new untitled SQL document via the existing `SqlDocumentService.newQuery()` (same mechanism the "Show Query" execution-plan action already uses). No SQL Tools Service round trip, no FROM-clause parsing — table name comes from column metadata (`baseTableName`/`baseSchemaName`) already flowing into the webview.

**Tech Stack:** TypeScript, React, Fluent UI (`@fluentui/react-components`), SlickGrid (`@slickgrid-universal/common`, referenced via the ambient global `Slick` namespace used throughout this codebase), `vscode-jsonrpc` (`RequestType`), Mocha + Chai + Sinon for unit tests.

**Spec:** `C:\Fred\VSCode-MSSQL-Plugin\vscode-mssql-fork-plan.md` (carries the full feature spec, non-goals, and prior research — read alongside this plan; this plan's wiring map section is the direct source for the tasks below).

## Global Constraints

- **v1 scope: single-row selection only.** No multi-row batch generation for Generate SELECT/UPDATE/DELETE/INSERT (multi-row "Copy as INSERT INTO" bulk-copy is a _pre-existing, separate_ feature and keeps working as-is).
- **WHERE clause** = exactly the selected column/value pairs. NULL values render as `IS NULL`, never `= NULL`.
- **UPDATE SET clause** = every _other_ column in the row (not in the WHERE selection), pre-populated with current values, fully editable.
- **Table name**: use `baseTableName` (+ `baseSchemaName` if present) from column metadata. Fall back to literal `UnknownTable` only when `baseTableName` is empty.
- **Output**: generated SQL opens in a new untitled SQL editor tab. Never auto-executed.
- **Target grid**: the legacy/default SlickGrid grid only (`isBetaResultsGridEnabled: false` path). The FluentResultGrid (preview/beta grid) is explicitly out of scope for this plan.
- No primary-key detection, no join-awareness, no marketplace distribution concerns — all out of scope per the spec's non-goals.

---

## Task 1: Shared request/action types

**Files:**

- Modify: `extensions/mssql/src/sharedInterfaces/queryResult.ts:373-382` (insert after `CopyAsInsertIntoRequest`), `:563-572` (extend `GridContextMenuAction` enum)

**Interfaces:**

- Produces: `GridContextMenuAction.GenerateSelect | GenerateUpdate | GenerateDelete | GenerateInsert` (string enum members), `OpenGeneratedQueryRequestParams { uri: string; sql: string }`, `OpenGeneratedQueryRequest.type: RequestType<OpenGeneratedQueryRequestParams, void, void>`. Tasks 4, 5, and 6 all import these.

- [ ] **Step 1: Add the four new `GridContextMenuAction` enum members**

In `extensions/mssql/src/sharedInterfaces/queryResult.ts`, change:

```ts
export enum GridContextMenuAction {
    SelectAll = "select-all",
    CopySelection = "copy-selection",
    CopyHeaders = "copy-headers",
    CopyWithHeaders = "copy-with-headers",
    CopyAsCsv = "copy-as-csv",
    CopyAsJson = "copy-as-json",
    CopyAsInClause = "copy-as-in-clause",
    CopyAsInsertInto = "copy-as-insert-into",
}
```

to:

```ts
export enum GridContextMenuAction {
    SelectAll = "select-all",
    CopySelection = "copy-selection",
    CopyHeaders = "copy-headers",
    CopyWithHeaders = "copy-with-headers",
    CopyAsCsv = "copy-as-csv",
    CopyAsJson = "copy-as-json",
    CopyAsInClause = "copy-as-in-clause",
    CopyAsInsertInto = "copy-as-insert-into",
    GenerateSelect = "generate-select",
    GenerateUpdate = "generate-update",
    GenerateDelete = "generate-delete",
    GenerateInsert = "generate-insert",
}
```

- [ ] **Step 2: Add the `OpenGeneratedQueryRequest` type**

Immediately after the existing `CopyAsInsertIntoRequest` namespace (after line 382), insert:

```ts
export interface OpenGeneratedQueryRequestParams {
    uri: string;
    sql: string;
}

export namespace OpenGeneratedQueryRequest {
    export const type = new RequestType<OpenGeneratedQueryRequestParams, void, void>(
        "openGeneratedQuery",
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd extensions/mssql && npx tsc --noEmit -p .`
Expected: no new errors (the enum/request additions are additive; nothing consumes them yet).

- [ ] **Step 4: Commit**

```bash
git add extensions/mssql/src/sharedInterfaces/queryResult.ts
git commit -m "feat: add GridContextMenuAction generate-* actions and OpenGeneratedQueryRequest"
```

---

## Task 2: Shared `sqlScriptGenerator.ts` module (extract + extend, with tests)

**Files:**

- Create: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`
- Create: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`

**Interfaces:**

- Consumes: `IDbColumn`, `DbCellValue`, `ISlickRange` from `../../sharedInterfaces/queryResult`; `IDisposableDataProvider` from `../pages/QueryResult/table/dataProvider`; `getEOL` from `./utils`.
- Produces (all exported, consumed by Task 3's notebook fix and Task 5's grid wiring):
    - `isNumericSqlType(dataTypeName?: string): boolean`
    - `sqlStr(v: string): string`
    - `escapeSqlIdentifier(value: string): string`
    - `getColumnInfo<T extends Slick.SlickData>(columnInfo: IDbColumn[], col: Slick.Column<T> | undefined): IDbColumn | undefined`
    - `getAllDataColumnIndices<T extends Slick.SlickData>(columns: Slick.Column<T>[]): number[]`
    - `getSelectedColumnIndices<T extends Slick.SlickData>(ranges: ISlickRange[], columns: Slick.Column<T>[]): number[]`
    - `isSingleRowSelection(ranges: ISlickRange[]): boolean`
    - `isFullRowSelected<T extends Slick.SlickData>(ranges: ISlickRange[], columns: Slick.Column<T>[]): boolean`
    - `ColumnValuePair<T>` interface `{ column: Slick.Column<T>; dbColumn: IDbColumn | undefined; cellValue: DbCellValue | undefined }`
    - `getColumnValuePair<T extends Slick.SlickData>(colIndex: number, row: number, columns: Slick.Column<T>[], dataProvider: IDisposableDataProvider<T>, columnInfo: IDbColumn[]): ColumnValuePair<T>`
    - `getColumnIdentifier<T>(pair: ColumnValuePair<T>): string`
    - `formatSqlValue<T>(pair: ColumnValuePair<T>): string`
    - `buildQualifiedTableName(dbColumn: IDbColumn | undefined): string`
    - `buildWhereClause<T>(pairs: ColumnValuePair<T>[]): string`
    - `generateSelect<T extends Slick.SlickData>(row: number, selectedColumnIndices: number[], columns: Slick.Column<T>[], dataProvider: IDisposableDataProvider<T>, columnInfo: IDbColumn[]): string`
    - `generateUpdate<T extends Slick.SlickData>(row: number, selectedColumnIndices: number[], columns: Slick.Column<T>[], dataProvider: IDisposableDataProvider<T>, columnInfo: IDbColumn[]): string`
    - `generateDelete<T extends Slick.SlickData>(row: number, selectedColumnIndices: number[], columns: Slick.Column<T>[], dataProvider: IDisposableDataProvider<T>, columnInfo: IDbColumn[]): string`
    - `generateInsertForRows<T extends Slick.SlickData>(ranges: ISlickRange[], columns: Slick.Column<T>[], dataProvider: IDisposableDataProvider<T>, columnInfo: IDbColumn[]): string`

- [ ] **Step 1: Write the failing tests**

Create `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect } from "chai";
import type { IDbColumn } from "vscode-mssql";
import type { IDisposableDataProvider } from "../../../src/webviews/pages/QueryResult/table/dataProvider";
import {
    buildQualifiedTableName,
    generateDelete,
    generateInsertForRows,
    generateSelect,
    generateUpdate,
    getSelectedColumnIndices,
    isFullRowSelected,
    isSingleRowSelection,
} from "../../../src/webviews/common/sqlScriptGenerator";

function makeRange(fromRow: number, toRow: number, fromCell: number, toCell: number) {
    return { fromRow, toRow, fromCell, toCell };
}

function makeCol(index: number, name: string, toolTip?: string): Slick.Column<Slick.SlickData> {
    return {
        field: String(index),
        id: String(index),
        name,
        toolTip,
    } as Slick.Column<Slick.SlickData>;
}

function makeDbCol(
    dataTypeName: string,
    baseColumnName?: string,
    baseTableName?: string,
    baseSchemaName?: string,
): IDbColumn {
    return { dataTypeName, baseColumnName, baseTableName, baseSchemaName } as IDbColumn;
}

function makeCell(displayValue: string, isNull = false) {
    return { displayValue, isNull };
}

type CellRow = Record<string, { displayValue: string; isNull: boolean }>;

function makeProvider(rows: CellRow[]): IDisposableDataProvider<Slick.SlickData> {
    return {
        getItem: (row: number) => rows[row] ?? {},
    } as unknown as IDisposableDataProvider<Slick.SlickData>;
}

suite("sqlScriptGenerator", () => {
    suite("buildQualifiedTableName", () => {
        test("falls back to UnknownTable when baseTableName is empty", () => {
            expect(buildQualifiedTableName(makeDbCol("int"))).to.equal("UnknownTable");
        });

        test("uses schema-qualified, escaped table name when present", () => {
            expect(buildQualifiedTableName(makeDbCol("int", "Id", "Order] Item", "dbo"))).to.equal(
                "[dbo].[Order]] Item]",
            );
        });
    });

    suite("isSingleRowSelection / isFullRowSelected", () => {
        const cols = [makeCol(0, "Id"), makeCol(1, "Name")];

        test("single cell in a row is a single-row, non-full-row selection", () => {
            const ranges = [makeRange(0, 0, 0, 0)];
            expect(isSingleRowSelection(ranges)).to.equal(true);
            expect(isFullRowSelected(ranges, cols)).to.equal(false);
        });

        test("all columns of one row is a full-row selection", () => {
            const ranges = [makeRange(0, 0, 0, 1)];
            expect(isSingleRowSelection(ranges)).to.equal(true);
            expect(isFullRowSelected(ranges, cols)).to.equal(true);
        });

        test("multi-row selection is not single-row", () => {
            const ranges = [makeRange(0, 1, 0, 1)];
            expect(isSingleRowSelection(ranges)).to.equal(false);
            expect(isFullRowSelected(ranges, cols)).to.equal(false);
        });
    });

    suite("generateSelect / generateUpdate / generateDelete", () => {
        const columnInfo = [
            makeDbCol("int", "Id", "Customers", "dbo"),
            makeDbCol("nvarchar", "Name", "Customers", "dbo"),
            makeDbCol("nvarchar", "Email", "Customers", "dbo"),
        ];
        const cols = [makeCol(0, "Id"), makeCol(1, "Name"), makeCol(2, "Email")];
        const rows: CellRow[] = [
            {
                "0": makeCell("42"),
                "1": makeCell("Alice"),
                "2": makeCell("", true),
            },
        ];

        test("generateSelect builds WHERE from only the selected columns, IS NULL for null cells", () => {
            const provider = makeProvider(rows);
            const selected = getSelectedColumnIndices([makeRange(0, 0, 0, 0)], cols);
            const result = generateSelect(0, selected, cols, provider, columnInfo);
            expect(result).to.equal(
                "SELECT [Id], [Name], [Email]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] = 42;",
            );
        });

        test("generateDelete uses only the selected column as WHERE", () => {
            const provider = makeProvider(rows);
            const selected = getSelectedColumnIndices([makeRange(0, 0, 0, 0)], cols);
            const result = generateDelete(0, selected, cols, provider, columnInfo);
            expect(result).to.equal("DELETE FROM [dbo].[Customers]\r\nWHERE [Id] = 42;");
        });

        test("generateUpdate SETs every other column, NULL cell stays NULL", () => {
            const provider = makeProvider(rows);
            const selected = getSelectedColumnIndices([makeRange(0, 0, 0, 0)], cols);
            const result = generateUpdate(0, selected, cols, provider, columnInfo);
            expect(result).to.equal(
                "UPDATE [dbo].[Customers]\r\nSET [Name] = 'Alice',\r\n    [Email] = NULL\r\nWHERE [Id] = 42;",
            );
        });

        test("generateSelect renders IS NULL in WHERE when the selected cell is null", () => {
            const provider = makeProvider(rows);
            const selected = getSelectedColumnIndices([makeRange(0, 0, 2, 2)], cols);
            const result = generateSelect(0, selected, cols, provider, columnInfo);
            expect(result).to.include("WHERE [Email] IS NULL");
        });
    });

    suite("generateInsertForRows", () => {
        test("uses the real table name instead of a placeholder", () => {
            const columnInfo = [makeDbCol("nvarchar", "Name", "Customers", "dbo")];
            const cols = [makeCol(0, "Name")];
            const provider = makeProvider([{ "0": makeCell("Alice") }]);
            const result = generateInsertForRows(
                [makeRange(0, 0, 0, 0)],
                cols,
                provider,
                columnInfo,
            );
            expect(result).to.equal(
                "INSERT INTO [dbo].[Customers] ([Name])\r\nVALUES\r\n    ('Alice');",
            );
        });

        test("falls back to UnknownTable when no table metadata is available", () => {
            const columnInfo = [makeDbCol("nvarchar")];
            const cols = [makeCol(0, "Name")];
            const provider = makeProvider([{ "0": makeCell("Alice") }]);
            const result = generateInsertForRows(
                [makeRange(0, 0, 0, 0)],
                cols,
                provider,
                columnInfo,
            );
            expect(result).to.equal(
                "INSERT INTO UnknownTable ([Name])\r\nVALUES\r\n    ('Alice');",
            );
        });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extensions/mssql && npm test -- --grep "sqlScriptGenerator"`
Expected: FAIL — `Cannot find module '../../../src/webviews/common/sqlScriptGenerator'`

- [ ] **Step 3: Write the module**

Create `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DbCellValue, IDbColumn, ISlickRange } from "../../sharedInterfaces/queryResult";
import type { IDisposableDataProvider } from "../pages/QueryResult/table/dataProvider";
import { getEOL } from "./utils";

export const NUMERIC_SQL_TYPES = new Set([
    "int",
    "bigint",
    "smallint",
    "tinyint",
    "decimal",
    "numeric",
    "float",
    "real",
    "money",
    "smallmoney",
    "bit",
]);

const SQL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
export const INSERT_ROW_LIMIT = 1000;

export function isNumericSqlType(dataTypeName: string | undefined): boolean {
    return !!dataTypeName && NUMERIC_SQL_TYPES.has(dataTypeName.toLowerCase());
}

export function sqlStr(v: string): string {
    return "'" + v.replace(/'/g, "''") + "'";
}

export function escapeSqlIdentifier(value: string): string {
    return `[${value.replaceAll("]", "]]")}]`;
}

export function getColumnInfo<T extends Slick.SlickData>(
    columnInfo: IDbColumn[],
    col: Slick.Column<T> | undefined,
): IDbColumn | undefined {
    const colIndex = col?.field ? parseInt(col.field, 10) : NaN;
    return !isNaN(colIndex) ? columnInfo[colIndex] : undefined;
}

export function getAllDataColumnIndices<T extends Slick.SlickData>(
    columns: Slick.Column<T>[],
): number[] {
    const result: number[] = [];
    columns.forEach((col, i) => {
        if (col?.id !== "rowNumber" && col?.field) {
            result.push(i);
        }
    });
    return result;
}

export function getSelectedColumnIndices<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
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

export function isSingleRowSelection(ranges: ISlickRange[]): boolean {
    return ranges.length === 1 && ranges[0].fromRow === ranges[0].toRow;
}

export function isFullRowSelected<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
): boolean {
    const dataColIndices = getAllDataColumnIndices(columns);
    if (!isSingleRowSelection(ranges) || dataColIndices.length === 0) {
        return false;
    }
    const [range] = ranges;
    const minIdx = Math.min(...dataColIndices);
    const maxIdx = Math.max(...dataColIndices);
    return range.fromCell <= minIdx && range.toCell >= maxIdx;
}

export interface ColumnValuePair<T extends Slick.SlickData> {
    column: Slick.Column<T>;
    dbColumn: IDbColumn | undefined;
    cellValue: DbCellValue | undefined;
}

export function getColumnValuePair<T extends Slick.SlickData>(
    colIndex: number,
    row: number,
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
): ColumnValuePair<T> {
    const column = columns[colIndex];
    const item = dataProvider.getItem(row) as Slick.SlickData;
    const cellValue = column?.field ? (item?.[column.field] as DbCellValue | undefined) : undefined;
    return { column, dbColumn: getColumnInfo(columnInfo, column), cellValue };
}

export function getColumnIdentifier<T extends Slick.SlickData>(pair: ColumnValuePair<T>): string {
    return pair.dbColumn?.baseColumnName || pair.column?.toolTip || pair.column?.name || "";
}

export function formatSqlValue<T extends Slick.SlickData>(pair: ColumnValuePair<T>): string {
    if (!pair.cellValue || pair.cellValue.isNull) {
        return "NULL";
    }
    const val = pair.cellValue.displayValue ?? "";
    return isNumericSqlType(pair.dbColumn?.dataTypeName) && SQL_NUMBER_PATTERN.test(val)
        ? val
        : sqlStr(val);
}

export function buildQualifiedTableName(dbColumn: IDbColumn | undefined): string {
    if (!dbColumn?.baseTableName) {
        return "UnknownTable";
    }
    const table = escapeSqlIdentifier(dbColumn.baseTableName);
    return dbColumn.baseSchemaName
        ? `${escapeSqlIdentifier(dbColumn.baseSchemaName)}.${table}`
        : table;
}

export function buildWhereClause<T extends Slick.SlickData>(pairs: ColumnValuePair<T>[]): string {
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

function getRowPairs<T extends Slick.SlickData>(
    colIndices: number[],
    row: number,
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
): ColumnValuePair<T>[] {
    return colIndices.map((i) => getColumnValuePair(i, row, columns, dataProvider, columnInfo));
}

export function generateSelect<T extends Slick.SlickData>(
    row: number,
    selectedColumnIndices: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
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
    const table = buildQualifiedTableName(wherePairs[0]?.dbColumn ?? allPairs[0]?.dbColumn);
    return `SELECT ${colNames}${eol}FROM ${table}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateDelete<T extends Slick.SlickData>(
    row: number,
    selectedColumnIndices: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
): string {
    const eol = getEOL();
    const wherePairs = getRowPairs(selectedColumnIndices, row, columns, dataProvider, columnInfo);
    const table = buildQualifiedTableName(wherePairs[0]?.dbColumn);
    return `DELETE FROM ${table}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateUpdate<T extends Slick.SlickData>(
    row: number,
    selectedColumnIndices: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
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
    const table = buildQualifiedTableName(wherePairs[0]?.dbColumn ?? setPairs[0]?.dbColumn);
    const setClause = setPairs
        .map((p) => `${escapeSqlIdentifier(getColumnIdentifier(p))} = ${formatSqlValue(p)}`)
        .join(`,${eol}    `);
    return `UPDATE ${table}${eol}SET ${setClause}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateInsertForRows<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
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
                formatSqlValue(getColumnValuePair(index, r, columns, dataProvider, columnInfo)),
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
    const table = buildQualifiedTableName(colMeta[0]?.dbColumn);
    const statements: string[] = [];
    for (let start = 0; start < valueRows.length; start += INSERT_ROW_LIMIT) {
        const batch = valueRows.slice(start, start + INSERT_ROW_LIMIT);
        const rowLines = batch.map((row, i) => row + (i < batch.length - 1 ? "," : ";"));
        statements.push([`INSERT INTO ${table} (${colNames})`, "VALUES", ...rowLines].join(eol));
    }
    return statements.join(eol + eol);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extensions/mssql && npm test -- --grep "sqlScriptGenerator"`
Expected: PASS (all suites green)

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/common/sqlScriptGenerator.ts extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts
git commit -m "feat: add shared sqlScriptGenerator module for SELECT/UPDATE/DELETE/INSERT generation"
```

---

## Task 3: Fix the Notebook Renderer's "TableName" bug (upstream #21387) by delegating to the shared module

**Files:**

- Modify: `extensions/mssql/src/webviews/pages/NotebookRenderer/notebookContextMenu.plugin.ts:14-52` (imports/statics), `:691-796` (`formatAsInClause`, `formatAsInsertInto`, `isNumericSqlType`, `sqlStr`, `escapeSqlIdentifier`)
- Modify: `extensions/mssql/test/unit/notebooks/notebookContextMenu.test.ts:26-28,383-584` (`makeDbCol` helper + all `formatAsInsertInto` assertions)

**Interfaces:**

- Consumes: `isNumericSqlType`, `sqlStr`, `generateInsertForRows` from `../../common/sqlScriptGenerator` (Task 2).
- Produces: `NotebookContextMenu.formatAsInsertInto` keeps its existing public signature `(ranges: Slick.Range[], columns: Slick.Column<T>[], dataProvider: IDisposableDataProvider<T>) => string` — callers (the class's own `handleAction` switch, and the test suite) are unaffected by the internal rewrite.

- [ ] **Step 1: Update the failing/changed assertions in the test file first**

In `extensions/mssql/test/unit/notebooks/notebookContextMenu.test.ts`, change the `makeDbCol` helper (lines 26-28) from:

```ts
function makeDbCol(dataTypeName: string): IDbColumn {
    return { dataTypeName } as IDbColumn;
}
```

to:

```ts
function makeDbCol(
    dataTypeName: string,
    baseTableName?: string,
    baseSchemaName?: string,
): IDbColumn {
    return { dataTypeName, baseTableName, baseSchemaName } as IDbColumn;
}
```

Then, in the `formatAsInsertInto` and `multi-range selections` suites, replace every literal `TableName` in an expected string with `UnknownTable` (these fixtures never set `baseTableName`, so the generator's documented fallback now applies — this is the bug fix becoming visible in the existing tests). Concretely, in lines 389, 397, 405, 413, 422, 436, 446, 478 (`.match(/INSERT INTO TableName/g)` → `.match(/INSERT INTO UnknownTable/g)`), 479, 566, 582: replace `TableName` with `UnknownTable`.

Then add two new tests at the end of the `formatAsInsertInto` suite (right before its closing `});` at line 499), verifying the real fix:

```ts
test("uses the real table name when column metadata provides one", () => {
    const menu = makeMenu([makeDbCol("nvarchar", "Customers")]);
    const cols = [makeCol(0, "Name")];
    const rows: CellRow[] = [{ "0": makeCell("Alice") }];
    const result = fmt.insertInto(menu, [makeRange(0, 0, 0, 0)], cols, makeProvider(rows));
    expect(result).to.equal("INSERT INTO [Customers] ([Name])\r\nVALUES\r\n    ('Alice');");
});

test("schema-qualifies the table name when baseSchemaName is present", () => {
    const menu = makeMenu([makeDbCol("nvarchar", "Customers", "dbo")]);
    const cols = [makeCol(0, "Name")];
    const rows: CellRow[] = [{ "0": makeCell("Alice") }];
    const result = fmt.insertInto(menu, [makeRange(0, 0, 0, 0)], cols, makeProvider(rows));
    expect(result).to.equal("INSERT INTO [dbo].[Customers] ([Name])\r\nVALUES\r\n    ('Alice');");
});
```

- [ ] **Step 2: Run the tests to verify the expected failures**

Run: `cd extensions/mssql && npm test -- --grep "formatAsInsertInto|insertInto"`
Expected: FAIL — old assertions now expect `UnknownTable`/real names but the code still emits the literal `TableName`; the two new tests fail with the same reason.

- [ ] **Step 3: Rewire `notebookContextMenu.plugin.ts` to delegate to the shared module**

In `extensions/mssql/src/webviews/pages/NotebookRenderer/notebookContextMenu.plugin.ts`:

Change the import block (lines 6-10) from:

```ts
import { locConstants } from "../../common/locConstants";
import { IDisposableDataProvider } from "../QueryResult/table/dataProvider";
import type { IDbColumn } from "../../../sharedInterfaces/queryResult";
import type { NotebookCopyAsCsvOptions } from "../../../sharedInterfaces/notebookQueryResult";
import { getEOL, isMac } from "../../common/utils";
```

to:

```ts
import { locConstants } from "../../common/locConstants";
import { IDisposableDataProvider } from "../QueryResult/table/dataProvider";
import type { IDbColumn } from "../../../sharedInterfaces/queryResult";
import type { NotebookCopyAsCsvOptions } from "../../../sharedInterfaces/notebookQueryResult";
import { getEOL, isMac } from "../../common/utils";
import {
    generateInsertForRows,
    isNumericSqlType as sharedIsNumericSqlType,
    sqlStr as sharedSqlStr,
} from "../../common/sqlScriptGenerator";
```

Remove the now-duplicated statics (lines 26-38 and 53) — delete:

```ts
    private static readonly NUMERIC_SQL_TYPES = new Set([
        "int",
        "bigint",
        "smallint",
        "tinyint",
        "decimal",
        "numeric",
        "float",
        "real",
        "money",
        "smallmoney",
        "bit",
    ]);

```

and delete the line:

```ts
    private static readonly SQL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
```

and delete:

```ts
    private static readonly INSERT_ROW_LIMIT = 1000;
```

(keep `JSON_NUMBER_TYPES` and `JSON_NUMBER_PATTERN` — those are JSON-specific, not part of the shared module).

Replace the private helper methods at the bottom of the class (the old `isNumericSqlType`, `sqlStr`, `escapeSqlIdentifier` — lines 788-800) by deleting them entirely, since callers below now use the shared imports directly.

Replace the body of `formatAsInClause` (around line 705, 716, 718) — change:

```ts
            if (col === undefined) {
                col = rangeCols[0];
                isNumeric = this.isNumericSqlType(this.getColumnInfo(col)?.dataTypeName);
```

to:

```ts
            if (col === undefined) {
                col = rangeCols[0];
                isNumeric = sharedIsNumericSqlType(this.getColumnInfo(col)?.dataTypeName);
```

and change:

```ts
const val = cellVal?.isNull
    ? "NULL"
    : isNumeric && NotebookContextMenu.SQL_NUMBER_PATTERN.test(rawVal)
      ? rawVal
      : this.sqlStr(rawVal);
```

to:

```ts
const val = cellVal?.isNull
    ? "NULL"
    : isNumeric && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawVal)
      ? rawVal
      : sharedSqlStr(rawVal);
```

Replace the entire body of `formatAsInsertInto` (lines 733-786) with a one-line delegation:

```ts
    public formatAsInsertInto(
        ranges: Slick.Range[],
        columns: Slick.Column<T>[],
        dataProvider: IDisposableDataProvider<T>,
    ): string {
        return generateInsertForRows(ranges, columns, dataProvider, this.columnInfo);
    }
```

Note: `isNumericSqlType` is still called for `formatAsJson`'s numeric detection via `NotebookContextMenu.JSON_NUMBER_TYPES` — that check is separate and untouched. Only the SQL-value numeric check (used by `formatAsInClause` and the now-removed `formatAsInsertInto` body) is replaced.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extensions/mssql && npm test -- --grep "NotebookContextMenu"`
Expected: PASS — every `formatAsInsertInto` assertion now matches `UnknownTable` or the real table name, and `formatAsInClause` behavior is unchanged (still passes numeric/string formatting tests).

- [ ] **Step 5: Typecheck the whole extension**

Run: `cd extensions/mssql && npx tsc --noEmit -p .`
Expected: no errors (confirms no leftover references to the deleted private statics/methods).

- [ ] **Step 6: Commit**

```bash
git add extensions/mssql/src/webviews/pages/NotebookRenderer/notebookContextMenu.plugin.ts extensions/mssql/test/unit/notebooks/notebookContextMenu.test.ts
git commit -m "fix: Notebook Copy as INSERT INTO now uses real table name instead of TableName placeholder"
```

---

## Task 4: Grid context menu UI — new items, conditionally shown by selection shape

**Files:**

- Modify: `extensions/mssql/src/webviews/common/locConstants.ts:1188-1195`
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/queryResultStateProvider.tsx:58-63,108-113,179-182,292-303`
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/GridContextMenu.tsx`

**Interfaces:**

- Consumes: `GridContextMenuAction.GenerateSelect/GenerateUpdate/GenerateDelete/GenerateInsert` (Task 1).
- Produces: `QueryResultReactProvider.showGridContextMenu(x, y, onAction, actionVisibility)` — the 4th parameter `actionVisibility: { showRowActions: boolean; showInsertAction: boolean }` is new and **required** going forward. Task 5's `ContextMenu.handleContextMenu` is the only caller and is updated in this same task's scope of "who must change together"... but per the plan's task boundary it's implemented in Task 5, since it depends on the selection-shape helpers from Task 2. For this task, keep the parameter optional (`actionVisibility?: ...`) defaulting to `{ showRowActions: false, showInsertAction: false }` so the type change alone doesn't break the existing caller before Task 5 lands.

- [ ] **Step 1: Add the four new label strings**

In `extensions/mssql/src/webviews/common/locConstants.ts`, after line 1192 (`copyAsInsertInto: l10n.t("Copy as INSERT INTO"),`), insert:

```ts
            generateSelect: l10n.t("Generate SELECT"),
            generateUpdate: l10n.t("Generate UPDATE"),
            generateDelete: l10n.t("Generate DELETE"),
            generateInsert: l10n.t("Generate INSERT"),
```

- [ ] **Step 2: Extend `QueryResultReactProvider.showGridContextMenu` with an optional selection-shape parameter**

In `extensions/mssql/src/webviews/pages/QueryResult/queryResultStateProvider.tsx`, change the interface (lines 58-62):

```ts
    showGridContextMenu: (
        x: number,
        y: number,
        onAction: (action: GridContextMenuAction) => void | Promise<void>,
    ) => void;
```

to:

```ts
    showGridContextMenu: (
        x: number,
        y: number,
        onAction: (action: GridContextMenuAction) => void | Promise<void>,
        actionVisibility?: GridContextMenuActionVisibility,
    ) => void;
```

Add the new type just above the `QueryResultReactProvider` interface (before line 51):

```ts
export interface GridContextMenuActionVisibility {
    showRowActions: boolean;
    showInsertAction: boolean;
}
```

Update the `menuState` shape (lines 108-113) from:

```ts
const [menuState, setMenuState] = useState<{
    open: boolean;
    x: number;
    y: number;
    onAction?: (action: GridContextMenuAction) => void | Promise<void>;
}>({ open: false, x: 0, y: 0 });
```

to:

```ts
const [menuState, setMenuState] = useState<{
    open: boolean;
    x: number;
    y: number;
    onAction?: (action: GridContextMenuAction) => void | Promise<void>;
    actionVisibility: GridContextMenuActionVisibility;
}>({
    open: false,
    x: 0,
    y: 0,
    actionVisibility: { showRowActions: false, showInsertAction: false },
});
```

Update the `showGridContextMenu` implementation (lines 179-182) from:

```ts
            showGridContextMenu: (x: number, y: number, onAction) => {
                hideFilterPopup();
                setMenuState({ open: true, x, y, onAction });
            },
```

to:

```ts
            showGridContextMenu: (x: number, y: number, onAction, actionVisibility) => {
                hideFilterPopup();
                setMenuState({
                    open: true,
                    x,
                    y,
                    onAction,
                    actionVisibility: actionVisibility ?? {
                        showRowActions: false,
                        showInsertAction: false,
                    },
                });
            },
```

Update the render call site (lines 292-303) from:

```tsx
{
    menuState.open && (
        <GridContextMenu
            x={menuState.x}
            y={menuState.y}
            open={menuState.open}
            onAction={async (action) => {
                await menuState.onAction?.(action);
                setMenuState((s) => ({ ...s, open: false }));
            }}
            onClose={() => setMenuState((s) => ({ ...s, open: false }))}
        />
    );
}
```

to:

```tsx
{
    menuState.open && (
        <GridContextMenu
            x={menuState.x}
            y={menuState.y}
            open={menuState.open}
            actionVisibility={menuState.actionVisibility}
            onAction={async (action) => {
                await menuState.onAction?.(action);
                setMenuState((s) => ({ ...s, open: false }));
            }}
            onClose={() => setMenuState((s) => ({ ...s, open: false }))}
        />
    );
}
```

- [ ] **Step 3: Add the new menu items to `GridContextMenu.tsx`**

In `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/GridContextMenu.tsx`, add `MenuDivider` to the Fluent import (line 7) — change:

```ts
import { Menu, MenuList, MenuItem, MenuPopover, MenuTrigger } from "@fluentui/react-components";
```

to:

```ts
import {
    Menu,
    MenuList,
    MenuItem,
    MenuPopover,
    MenuTrigger,
    MenuDivider,
} from "@fluentui/react-components";
```

Add this import line near the top of the file (after line 10's `useVscodeWebview` import), since `GridContextMenuActionVisibility` is exported from `queryResultStateProvider`:

```ts
import type { GridContextMenuActionVisibility } from "../../queryResultStateProvider";
```

(This is a type-only import, so it does not create a runtime circular dependency even though `queryResultStateProvider.tsx` itself renders `<GridContextMenu>`.)

Then extend `GridContextMenuProps` (lines 14-20). Change:

```ts
export interface GridContextMenuProps {
    x: number;
    y: number;
    open: boolean;
    onAction: (action: GridContextMenuAction) => void;
    onClose: () => void;
}
```

to:

```ts
export interface GridContextMenuProps {
    x: number;
    y: number;
    open: boolean;
    actionVisibility: GridContextMenuActionVisibility;
    onAction: (action: GridContextMenuAction) => void;
    onClose: () => void;
}
```

Add `actionVisibility` to the destructured props (line 29-35):

```ts
export const GridContextMenu: React.FC<GridContextMenuProps> = ({
    x,
    y,
    open,
    actionVisibility,
    onAction,
    onClose,
}) => {
```

Insert the new items right after the "Copy as" `<Menu>` submenu block closes (after line 144's `</Menu>`, before line 145's `</MenuList>`):

```tsx
{
    (actionVisibility.showRowActions || actionVisibility.showInsertAction) && <MenuDivider />;
}
{
    actionVisibility.showRowActions && (
        <>
            <MenuItem
                className={styles.menuItem}
                onClick={() => onAction(GridContextMenuAction.GenerateSelect)}>
                {locConstants.queryResult.generateSelect}
            </MenuItem>
            <MenuItem
                className={styles.menuItem}
                onClick={() => onAction(GridContextMenuAction.GenerateUpdate)}>
                {locConstants.queryResult.generateUpdate}
            </MenuItem>
            <MenuItem
                className={styles.menuItem}
                onClick={() => onAction(GridContextMenuAction.GenerateDelete)}>
                {locConstants.queryResult.generateDelete}
            </MenuItem>
        </>
    );
}
{
    actionVisibility.showInsertAction && (
        <MenuItem
            className={styles.menuItem}
            onClick={() => onAction(GridContextMenuAction.GenerateInsert)}>
            {locConstants.queryResult.generateInsert}
        </MenuItem>
    );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd extensions/mssql && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/common/locConstants.ts extensions/mssql/src/webviews/pages/QueryResult/queryResultStateProvider.tsx extensions/mssql/src/webviews/pages/QueryResult/table/plugins/GridContextMenu.tsx
git commit -m "feat: add Generate SELECT/UPDATE/DELETE/INSERT items to grid context menu, gated by selection shape"
```

---

## Task 5: Wire the legacy grid's `ContextMenu` plugin to compute selection shape and generate SQL

**Files:**

- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`
- Create: `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`

**Interfaces:**

- Consumes: `isSingleRowSelection`, `isFullRowSelected`, `getSelectedColumnIndices`, `generateSelect`, `generateUpdate`, `generateDelete`, `generateInsertForRows` from `../../../../common/sqlScriptGenerator` (Task 2); `OpenGeneratedQueryRequest` from `sharedInterfaces/queryResult` (Task 1); `tryCombineSelections` from `../utils` (already exists, not currently imported by this file); `IDisposableDataProvider` from `../dataProvider`.
- Produces: no new exports — this task closes the loop from grid right-click to the extension host request.

- [ ] **Step 1: Write the failing tests**

Create `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect } from "chai";
import * as sinon from "sinon";
import { ContextMenu } from "../../../src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin";
import {
    GridContextMenuAction,
    OpenGeneratedQueryRequest,
} from "../../../src/sharedInterfaces/queryResult";
import type { ResultSetSummary } from "../../../src/sharedInterfaces/queryResult";
import type { QueryResultReactProvider } from "../../../src/webviews/pages/QueryResult/queryResultStateProvider";

function makeRange(fromRow: number, toRow: number, fromCell: number, toCell: number) {
    return { fromRow, toRow, fromCell, toCell };
}

function makeCol(index: number, name: string): Slick.Column<Slick.SlickData> {
    return { field: String(index), id: String(index), name } as Slick.Column<Slick.SlickData>;
}

suite("ContextMenu (legacy grid) generate-* actions", () => {
    const sandbox = sinon.createSandbox();
    let slickDescriptor: PropertyDescriptor | undefined;

    suiteSetup(() => {
        slickDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Slick");
        Object.defineProperty(globalThis, "Slick", {
            value: {
                EventHandler: class {
                    public subscribe = sandbox.stub();
                    public unsubscribeAll = sandbox.stub();
                },
            },
            configurable: true,
        });
    });

    suiteTeardown(() => {
        if (slickDescriptor) {
            Object.defineProperty(globalThis, "Slick", slickDescriptor);
        }
    });

    teardown(() => sandbox.restore());

    const columnInfo = [
        {
            dataTypeName: "int",
            baseColumnName: "Id",
            baseTableName: "Customers",
            baseSchemaName: "dbo",
        },
        {
            dataTypeName: "nvarchar",
            baseColumnName: "Name",
            baseTableName: "Customers",
            baseSchemaName: "dbo",
        },
    ] as ResultSetSummary["columnInfo"];

    const cols = [makeCol(0, "Id"), makeCol(1, "Name")];
    const row = {
        "0": { displayValue: "1", isNull: false },
        "1": { displayValue: "Alice", isNull: false },
    };

    function makeGridAndContext(selectedRanges: unknown[]) {
        const grid = {
            getSelectionModel: () => ({ getSelectedRanges: () => selectedRanges }),
            getColumns: () => cols,
            getData: () => ({ getItem: (r: number) => (r === 0 ? row : {}) }),
        };
        const sendRequest = sandbox.stub().resolves();
        const queryResultContext = {
            log: { trace: sandbox.stub(), warn: sandbox.stub() },
            extensionRpc: { sendRequest },
            showGridContextMenu: sandbox.stub(),
            hideGridContextMenu: sandbox.stub(),
            showCopyIndicator: sandbox.stub(),
        } as unknown as QueryResultReactProvider;
        return { grid, queryResultContext, sendRequest };
    }

    test("GenerateSelect sends OpenGeneratedQueryRequest with WHERE built from the selected cell only", async () => {
        const { grid, queryResultContext, sendRequest } = makeGridAndContext([
            makeRange(0, 0, 0, 0),
        ]);
        const menu = new ContextMenu<Slick.SlickData>(
            "file:///test.sql",
            { batchId: 0, id: 0, rowCount: 1, columnInfo } as ResultSetSummary,
            queryResultContext,
        );
        menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
        await (
            menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
        ).handleMenuAction(GridContextMenuAction.GenerateSelect);

        expect(sendRequest.calledOnce).to.equal(true);
        const [reqType, params] = sendRequest.firstCall.args;
        expect(reqType).to.equal(OpenGeneratedQueryRequest.type);
        expect(params.uri).to.equal("file:///test.sql");
        expect(params.sql).to.equal(
            "SELECT [Id], [Name]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] = 1;",
        );
    });

    test("GenerateInsert sends a single-row INSERT for a full-row selection", async () => {
        const { grid, queryResultContext, sendRequest } = makeGridAndContext([
            makeRange(0, 0, 0, 1),
        ]);
        const menu = new ContextMenu<Slick.SlickData>(
            "file:///test.sql",
            { batchId: 0, id: 0, rowCount: 1, columnInfo } as ResultSetSummary,
            queryResultContext,
        );
        menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
        await (
            menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
        ).handleMenuAction(GridContextMenuAction.GenerateInsert);

        const [, params] = sendRequest.firstCall.args;
        expect(params.sql).to.equal(
            "INSERT INTO [dbo].[Customers] ([Id], [Name])\r\nVALUES\r\n    (1, 'Alice');",
        );
    });

    test("does nothing and warns when the selection spans more than one row", async () => {
        const { grid, queryResultContext, sendRequest } = makeGridAndContext([
            makeRange(0, 1, 0, 0),
        ]);
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extensions/mssql && npm test -- --grep "ContextMenu \(legacy grid\)"`
Expected: FAIL — `handleMenuAction`'s `default` branch logs "Unknown action" for the new enum values (no case handles them yet), so `sendRequest` is never called.

- [ ] **Step 3: Update `contextMenu.plugin.ts`**

Change the import block (lines 6-22) from:

```ts
import {
    CopyAsCsvRequest,
    CopyAsJsonRequest,
    CopyAsInClauseRequest,
    CopyAsInsertIntoRequest,
    CopyHeadersRequest,
    CopySelectionRequest,
    GridContextMenuAction,
    ResultSetSummary,
} from "../../../../../sharedInterfaces/queryResult";
import { QueryResultReactProvider } from "../../queryResultStateProvider";
import { HybridDataProvider } from "../hybridDataProvider";
import {
    convertDisplayedSelectionToActual,
    selectEntireGrid,
    tryCombineSelectionsForResults,
} from "../utils";
```

to:

```ts
import {
    CopyAsCsvRequest,
    CopyAsJsonRequest,
    CopyAsInClauseRequest,
    CopyAsInsertIntoRequest,
    CopyHeadersRequest,
    CopySelectionRequest,
    GridContextMenuAction,
    OpenGeneratedQueryRequest,
    ResultSetSummary,
} from "../../../../../sharedInterfaces/queryResult";
import { QueryResultReactProvider } from "../../queryResultStateProvider";
import { HybridDataProvider } from "../hybridDataProvider";
import type { IDisposableDataProvider } from "../dataProvider";
import {
    convertDisplayedSelectionToActual,
    selectEntireGrid,
    tryCombineSelections,
    tryCombineSelectionsForResults,
} from "../utils";
import {
    generateDelete,
    generateInsertForRows,
    generateSelect,
    generateUpdate,
    getSelectedColumnIndices,
    isFullRowSelected,
    isSingleRowSelection,
} from "../../../../common/sqlScriptGenerator";
```

Replace `handleContextMenu` (lines 53-74) to compute and pass selection shape:

```ts
    private handleContextMenu(e: Event): void {
        e.preventDefault();
        const mouseEvent = e as MouseEvent;
        // Calculate adjusted x/y so the menu fits within viewport (with some estimated size)
        const margin = 8;
        const estimatedWidth = 260; // approximate width
        const estimatedHeight = 260; // approximate height
        const maxX = Math.max(margin, window.innerWidth - estimatedWidth - margin);
        const maxY = Math.max(margin, window.innerHeight - estimatedHeight - margin);
        const adjustedX = Math.min(Math.max(mouseEvent.pageX, margin), maxX);
        const adjustedY = Math.min(Math.max(mouseEvent.pageY, margin), maxY);

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
    }
```

Add four new `case`s to the `handleMenuAction` switch, right after the existing `CopyAsInsertInto` case (after line 172's closing `break;` for that case, before `default:`):

```ts
            case GridContextMenuAction.GenerateSelect:
            case GridContextMenuAction.GenerateUpdate:
            case GridContextMenuAction.GenerateDelete:
            case GridContextMenuAction.GenerateInsert: {
                log.trace(`${action} action triggered`);
                const gridColumns = this.grid.getColumns();
                const dataSelection = tryCombineSelections(
                    this.grid.getSelectionModel().getSelectedRanges(),
                );
                if (!isSingleRowSelection(dataSelection)) {
                    log.warn("Generate query actions require a single-row selection");
                    break;
                }
                const [range] = dataSelection;
                const dataProvider = this.grid.getData() as IDisposableDataProvider<T>;
                const columnInfo = this.resultSetSummary.columnInfo;
                const row = range.fromRow;
                const selectedColumnIndices = getSelectedColumnIndices([range], gridColumns);

                let sql: string;
                if (action === GridContextMenuAction.GenerateSelect) {
                    sql = generateSelect(row, selectedColumnIndices, gridColumns, dataProvider, columnInfo);
                } else if (action === GridContextMenuAction.GenerateUpdate) {
                    sql = generateUpdate(row, selectedColumnIndices, gridColumns, dataProvider, columnInfo);
                } else if (action === GridContextMenuAction.GenerateDelete) {
                    sql = generateDelete(row, selectedColumnIndices, gridColumns, dataProvider, columnInfo);
                } else {
                    sql = generateInsertForRows([range], gridColumns, dataProvider, columnInfo);
                }

                await this.queryResultContext.extensionRpc.sendRequest(OpenGeneratedQueryRequest.type, {
                    uri: this.uri,
                    sql,
                });
                break;
            }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extensions/mssql && npm test -- --grep "ContextMenu \(legacy grid\)"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `cd extensions/mssql && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts
git commit -m "feat: generate SELECT/UPDATE/DELETE/INSERT from grid selection and open in new SQL tab"
```

---

## Task 6: Host-side handler — open the generated SQL in a new untitled editor

**Files:**

- Modify: `extensions/mssql/src/queryResult/utils.ts:6-24` (imports), `:262-277` (insert new handler after `CopyAsInsertIntoRequest`)

**Interfaces:**

- Consumes: `OpenGeneratedQueryRequest` (Task 1); `webviewViewController.sqlDocumentService` (existing getter, already used by the `showQuery`/`openFileThroughLink` reducers in this same file); `ConnectionStrategy` from `../controllers/sqlDocumentService`.
- Produces: nothing new consumed elsewhere — this is the terminal step of the request.

- [ ] **Step 1: Add the `ConnectionStrategy` import**

In `extensions/mssql/src/queryResult/utils.ts`, change the import (line 19):

```ts
import { QueryResultWebviewController } from "./queryResultWebViewController";
```

to:

```ts
import { QueryResultWebviewController } from "./queryResultWebViewController";
import { ConnectionStrategy } from "../controllers/sqlDocumentService";
```

- [ ] **Step 2: Register the request handler**

In `registerCommonRequestHandlers`, immediately after the existing `qr.CopyAsInsertIntoRequest.type` handler block (after line 277's closing `});`), insert:

```ts
webviewController.onRequest(qr.OpenGeneratedQueryRequest.type, async (message) => {
    sendActionEvent(TelemetryViews.QueryResult, TelemetryActions.CopyResults, {
        additionalProps: {
            correlationId: correlationId,
            format: "generated-query",
        },
    });
    await webviewViewController.sqlDocumentService.newQuery({
        content: message.sql,
        connectionStrategy: ConnectionStrategy.CopyFromUri,
        sourceUri: message.uri,
    });
});
```

- [ ] **Step 3: Typecheck**

Run: `cd extensions/mssql && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add extensions/mssql/src/queryResult/utils.ts
git commit -m "feat: open generated grid queries in a new untitled SQL editor connected to the source query's connection"
```

---

## Task 7: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Build and launch the extension**

Run: `cd extensions/mssql && npm run build:extension:emit` then open the repo in VS Code and press F5 (Extension Development Host).

- [ ] **Step 2: Connect and run a query**

Connect to a test SQL Server/Azure SQL database, run `SELECT * FROM <some table with a few rows>` in the legacy grid (ensure the beta grid toggle is off).

- [ ] **Step 3: Verify cell-selection actions**

Select a single cell (e.g. an `Id` column value) in one row, right-click. Confirm the menu shows **Generate SELECT / Generate UPDATE / Generate DELETE** (not Generate INSERT). Click each one in turn and confirm:

- A new untitled SQL tab opens, connected to the same connection as the source query editor.
- **Generate SELECT**: `SELECT <all columns> FROM <real table> WHERE <selected column> = <value>;`
- **Generate UPDATE**: `UPDATE <real table> SET <every other column> = <value> WHERE <selected column> = <value>;`
- **Generate DELETE**: `DELETE FROM <real table> WHERE <selected column> = <value>;`

- [ ] **Step 4: Verify full-row selection action**

Select an entire row (all cells across all columns for one row), right-click. Confirm the menu shows **Generate INSERT** only (not the SELECT/UPDATE/DELETE items). Click it and confirm a new tab opens with `INSERT INTO <real table> (<all columns>) VALUES (<all values>);`.

- [ ] **Step 5: Verify NULL handling**

Run a query against a table with a nullable column containing at least one NULL value. Select that NULL cell and Generate SELECT/DELETE; confirm the WHERE clause renders `<column> IS NULL`, not `= NULL`. Generate UPDATE with a different column selected and confirm the NULL column's SET clause renders `<column> = NULL`.

- [ ] **Step 6: Verify multi-table query fallback**

Run a query with a JOIN across two tables, select a computed/ambiguous column's cell, and confirm the generated SQL falls back to `UnknownTable` rather than guessing.

- [ ] **Step 7: Verify the Notebook Renderer bug fix**

Open a `.ipynb` notebook, run a SQL cell against a real table, right-click a result cell → Copy as INSERT INTO → paste into a scratch file. Confirm it shows the real table name, not `TableName`.

- [ ] **Step 8: Run the full unit test suite**

Run: `cd extensions/mssql && npm test`
Expected: all suites pass, including the new/updated ones from Tasks 2, 3, and 5.

- [ ] **Step 9: Package a VSIX for team sharing (per the fork's distribution plan)**

Run: `cd extensions/mssql && npx vsce package` (or the repo's existing packaging script if one exists — check `package.json` scripts for `package`/`vsce` first).
Share the resulting `.vsix` with the team per the plan's "Now" distribution step; do not publish to the marketplace.
