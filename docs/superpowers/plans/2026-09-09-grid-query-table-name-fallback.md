# Grid Query Table-Name Fallback (FROM-clause parsing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Generate SELECT/UPDATE/DELETE/INSERT" from the results grid produce the real table name for simple single-table queries, instead of always falling back to `UnknownTable`.

**Architecture:** `IDbColumn.baseTableName`/`baseSchemaName` come back empty from SQL Tools Service for every query (confirmed root cause, STS-side bug, out of scope — see spec). Add a client-side fallback: when a context-menu "Generate ..." action fires, the webview asks the extension host (which has the original query text via `QueryRunner`) to resolve the table name by parsing the batch's `FROM` clause. The parser is deliberately conservative — it only resolves the simple `SELECT ... FROM [schema.]table [WHERE ...]` shape and returns `undefined` for anything with `JOIN`, `UNION`, subqueries, CTEs, comma-joins, or multiple statements, in which case behavior is unchanged (`UnknownTable`). This explicitly overrides the original plan's "no FROM-clause parsing" constraint (see spec §"Two options going forward", option 2) because `baseTableName` is empty for the common case, not just the documented edge case.

**Tech Stack:** TypeScript, mocha/chai (`vscode-test` unit test harness), vscode-languageclient `RequestType` (webview ⇄ extension-host RPC).

**Spec:** `docs/superpowers/plans/2026-09-08-grid-query-generation-debug-findings.md`

## Global Constraints

- Parser must be conservative: any ambiguity (JOIN/UNION/subquery/CTE/comma-join/multiple statements) returns `undefined`, never a guessed table name. A wrong guess is worse than `UnknownTable`.
- Existing behavior when `baseTableName` IS populated (e.g. if STS is fixed later) must take priority over the new fallback — the fallback only fires when `baseTableName` is empty.
- No changes to the STS/C# repo (out of scope, separate repo).
- Follow existing RPC pattern in `extensions/mssql/src/sharedInterfaces/queryResult.ts` (`RequestType<Params, Response, void>` + matching `webviewController.onRequest` handler in `extensions/mssql/src/queryResult/utils.ts`).

---

## File Structure

- Create: `extensions/mssql/src/queryResult/fromClauseTableParser.ts` — pure function `parseSingleTableFromClause(queryText: string): { tableName: string; schemaName?: string } | undefined`. No vscode dependency, easy to unit test.
- Create: `extensions/mssql/test/unit/queryResult/fromClauseTableParser.test.ts` — unit tests for the parser.
- Modify: `extensions/mssql/src/controllers/queryRunner.ts` — add `getBatchQueryText(batchId: number): Promise<string | undefined>`, reading the batch's own text range from the owner document (same technique already used in `runQuery`, queryRunner.ts:391-398).
- Modify: `extensions/mssql/src/models/sqlOutputContentProvider.ts` — add `resolveTableNameRequestHandler(uri: string, batchId: number): Promise<qr.ResolveTableNameResponse>` alongside the other `...RequestHandler` methods (near `copyAsInsertIntoRequestHandler`).
- Modify: `extensions/mssql/src/sharedInterfaces/queryResult.ts` — add `ResolveTableNameRequestParams`, `ResolveTableNameResponse`, `ResolveTableNameRequest` namespace, following the `CopyAsInsertIntoRequest` pattern.
- Modify: `extensions/mssql/src/queryResult/utils.ts` — wire `qr.ResolveTableNameRequest.type` to `resolveTableNameRequestHandler`.
- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts` — add `FallbackTableName` type; `buildQualifiedTableName` and `generateSelect`/`generateUpdate`/`generateDelete`/`generateInsertForRows` accept an optional fallback, used only when `baseTableName` is empty.
- Modify: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts` — tests for the new fallback parameter.
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts` — before building SQL for `GenerateSelect`/`GenerateUpdate`/`GenerateDelete`/`GenerateInsert`, request the resolved table name from the host and pass it through as the fallback.

---

### Task 1: `parseSingleTableFromClause` parser + tests

**Files:**

- Create: `extensions/mssql/src/queryResult/fromClauseTableParser.ts`
- Test: `extensions/mssql/test/unit/queryResult/fromClauseTableParser.test.ts`

**Interfaces:**

- Produces: `export function parseSingleTableFromClause(queryText: string): { tableName: string; schemaName?: string } | undefined` — used by Task 2.

- [ ] **Step 1: Write the failing tests**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect } from "chai";
import { parseSingleTableFromClause } from "../../../src/queryResult/fromClauseTableParser";

suite("parseSingleTableFromClause", () => {
    test("plain table name", () => {
        expect(parseSingleTableFromClause("SELECT * FROM Customers")).to.deep.equal({
            tableName: "Customers",
            schemaName: undefined,
        });
    });

    test("schema-qualified, bracketed identifiers", () => {
        expect(
            parseSingleTableFromClause("SELECT [Id], [Name] FROM [dbo].[Customers] WHERE [Id] = 1"),
        ).to.deep.equal({ tableName: "Customers", schemaName: "dbo" });
    });

    test("quoted identifiers", () => {
        expect(parseSingleTableFromClause('SELECT * FROM "dbo"."Customers"')).to.deep.equal({
            tableName: "Customers",
            schemaName: "dbo",
        });
    });

    test("three-part name takes schema + table, drops database", () => {
        expect(parseSingleTableFromClause("SELECT * FROM MyDb.dbo.Customers")).to.deep.equal({
            tableName: "Customers",
            schemaName: "dbo",
        });
    });

    test("trailing alias is ignored", () => {
        expect(
            parseSingleTableFromClause("SELECT c.Id FROM dbo.Customers AS c WHERE c.Id = 1"),
        ).to.deep.equal({ tableName: "Customers", schemaName: "dbo" });
    });

    test("ORDER BY / GROUP BY / semicolon all terminate the FROM clause", () => {
        expect(parseSingleTableFromClause("SELECT * FROM Customers ORDER BY Id;")).to.deep.equal({
            tableName: "Customers",
            schemaName: undefined,
        });
        expect(
            parseSingleTableFromClause("SELECT Id, COUNT(*) FROM Customers GROUP BY Id"),
        ).to.deep.equal({ tableName: "Customers", schemaName: undefined });
    });

    test("returns undefined for JOIN", () => {
        expect(
            parseSingleTableFromClause(
                "SELECT * FROM Customers c JOIN Orders o ON o.CustomerId = c.Id",
            ),
        ).to.equal(undefined);
    });

    test("returns undefined for UNION", () => {
        expect(
            parseSingleTableFromClause("SELECT Id FROM Customers UNION SELECT Id FROM Archive"),
        ).to.equal(undefined);
    });

    test("returns undefined for comma-join (old-style JOIN)", () => {
        expect(parseSingleTableFromClause("SELECT * FROM Customers, Orders")).to.equal(undefined);
    });

    test("returns undefined for subquery in FROM", () => {
        expect(parseSingleTableFromClause("SELECT * FROM (SELECT * FROM Customers) x")).to.equal(
            undefined,
        );
    });

    test("returns undefined for CTE", () => {
        expect(
            parseSingleTableFromClause("WITH cte AS (SELECT * FROM Customers) SELECT * FROM cte"),
        ).to.equal(undefined);
    });

    test("returns undefined for multiple statements", () => {
        expect(
            parseSingleTableFromClause("SELECT * FROM Customers; SELECT * FROM Orders;"),
        ).to.equal(undefined);
    });

    test("returns undefined for non-SELECT statement", () => {
        expect(parseSingleTableFromClause("EXEC dbo.MyProc")).to.equal(undefined);
    });

    test("ignores FROM keyword inside string literals and comments", () => {
        expect(
            parseSingleTableFromClause("SELECT 'a FROM b' AS x -- FROM comment\nFROM Customers"),
        ).to.deep.equal({ tableName: "Customers", schemaName: undefined });
    });

    test("returns undefined when there is no FROM clause", () => {
        expect(parseSingleTableFromClause("SELECT 1")).to.equal(undefined);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/mssql && npm run build && npm test -- --grep parseSingleTableFromClause`
Expected: FAIL (module `fromClauseTableParser` does not exist / compile error). If `--grep` isn't picked up by the `vscode-test` wrapper, run the full `npm test` and confirm the new suite fails/errors while the rest of the suite is unaffected.

- [ ] **Step 3: Implement the parser**

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Conservative, regex-based extraction of the single table target of a
 * `SELECT ... FROM [schema.]table [WHERE ...]` statement. Returns `undefined`
 * for anything that isn't unambiguously a single real table (JOIN, UNION,
 * subquery, CTE, comma-join, multiple statements, non-SELECT) -- a wrong
 * guess is worse than the `UnknownTable` fallback it feeds.
 */
export function parseSingleTableFromClause(
    queryText: string,
): { tableName: string; schemaName?: string } | undefined {
    const stripped = stripSqlNoise(queryText);

    const statements = stripped.split(";").filter((s) => s.trim().length > 0);
    if (statements.length !== 1) {
        return undefined;
    }

    const trimmed = stripped.trim();
    if (!/^select\b/i.test(trimmed)) {
        return undefined;
    }

    if (/\bjoin\b/i.test(stripped) || /\bunion\b/i.test(stripped)) {
        return undefined;
    }

    const fromMatches = stripped.match(/\bfrom\b/gi);
    if (!fromMatches || fromMatches.length !== 1) {
        return undefined;
    }

    const fromClauseMatch = stripped.match(
        /\bfrom\b([\s\S]*?)(?:\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\boption\b|$)/i,
    );
    if (!fromClauseMatch) {
        return undefined;
    }

    const clause = fromClauseMatch[1].trim();
    if (clause.includes("(") || clause.includes(",") || clause.length === 0) {
        return undefined;
    }

    const identifierPattern = /\[[^\]]+\]|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*/;
    const leadingIdentifiersPattern = new RegExp(
        `^(?:${identifierPattern.source})(?:\\.(?:${identifierPattern.source})){0,2}`,
    );
    const identifierChain = clause.match(leadingIdentifiersPattern)?.[0];
    if (!identifierChain) {
        return undefined;
    }

    const parts = identifierChain.match(new RegExp(identifierPattern.source, "g")) ?? [];
    if (parts.length === 0) {
        return undefined;
    }

    const unquote = (part: string): string => {
        if (part.startsWith("[") && part.endsWith("]")) {
            return part.slice(1, -1);
        }
        if (part.startsWith('"') && part.endsWith('"')) {
            return part.slice(1, -1);
        }
        return part;
    };

    const tableName = unquote(parts[parts.length - 1]);
    const schemaName = parts.length >= 2 ? unquote(parts[parts.length - 2]) : undefined;
    return { tableName, schemaName };
}

function stripSqlNoise(queryText: string): string {
    return queryText
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n\r]*/g, " ")
        .replace(/'(?:[^']|'')*'/g, " ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extensions/mssql && npm test`
Expected: PASS for all `parseSingleTableFromClause` tests, no regressions elsewhere.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/queryResult/fromClauseTableParser.ts extensions/mssql/test/unit/queryResult/fromClauseTableParser.test.ts
git commit -m "feat: add conservative FROM-clause table name parser"
```

---

### Task 2: `QueryRunner.getBatchQueryText`

**Files:**

- Modify: `extensions/mssql/src/controllers/queryRunner.ts`

**Interfaces:**

- Consumes: `this.batchSets: BatchSummary[]` (existing getter, queryRunner.ts:215-217), `BatchSummary.selection: ISelectionData` (`extensions/mssql/src/models/contracts/queryExecute.ts:19`), `this._ownerUri: string` (existing private field).
- Produces: `public async getBatchQueryText(batchId: number): Promise<string | undefined>` — used by Task 3.

- [ ] **Step 1: Add the method**

Add next to `getQueryString` (queryRunner.ts, after line 1525):

```typescript
    public async getBatchQueryText(batchId: number): Promise<string | undefined> {
        const batchSummary = this.batchSets[batchId];
        if (!batchSummary) {
            return undefined;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this._ownerUri));
        const selection = batchSummary.selection;
        if (!selection) {
            return doc.getText();
        }
        const range = new vscode.Range(
            new vscode.Position(selection.startLine, selection.startColumn),
            new vscode.Position(selection.endLine, selection.endColumn),
        );
        return doc.getText(range);
    }
```

- [ ] **Step 2: Typecheck**

Run: `cd extensions/mssql && npm run build:extension:typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/mssql/src/controllers/queryRunner.ts
git commit -m "feat: expose per-batch query text from QueryRunner"
```

---

### Task 3: `ResolveTableNameRequest` RPC (shared interface + host handler + wiring)

**Files:**

- Modify: `extensions/mssql/src/sharedInterfaces/queryResult.ts`
- Modify: `extensions/mssql/src/models/sqlOutputContentProvider.ts`
- Modify: `extensions/mssql/src/queryResult/utils.ts`

**Interfaces:**

- Consumes: `parseSingleTableFromClause` (Task 1), `QueryRunner.getBatchQueryText` (Task 2).
- Produces: `qr.ResolveTableNameRequest.type: RequestType<ResolveTableNameRequestParams, ResolveTableNameResponse, void>` with `ResolveTableNameRequestParams = { uri: string; batchId: number }` and `ResolveTableNameResponse = { tableName?: string; schemaName?: string }` — used by Task 5 (webview side).

- [ ] **Step 1: Add the shared request type**

In `extensions/mssql/src/sharedInterfaces/queryResult.ts`, right after the `OpenGeneratedQueryRequest` namespace (after line 393):

```typescript
export interface ResolveTableNameRequestParams {
    uri: string;
    batchId: number;
}

export interface ResolveTableNameResponse {
    tableName?: string;
    schemaName?: string;
}

export namespace ResolveTableNameRequest {
    export const type = new RequestType<
        ResolveTableNameRequestParams,
        ResolveTableNameResponse,
        void
    >("resolveTableName");
}
```

- [ ] **Step 2: Add the host handler**

In `extensions/mssql/src/models/sqlOutputContentProvider.ts`, add the import and the handler method next to `copyAsInsertIntoRequestHandler` (after line 290):

```typescript
import { parseSingleTableFromClause } from "../queryResult/fromClauseTableParser";
```

```typescript
    public async resolveTableNameRequestHandler(
        uri: string,
        batchId: number,
    ): Promise<{ tableName?: string; schemaName?: string }> {
        const queryRunner = this._queryResultsMap.get(uri)?.queryRunner;
        if (!queryRunner) {
            return {};
        }
        const queryText = await queryRunner.getBatchQueryText(batchId);
        if (!queryText) {
            return {};
        }
        return parseSingleTableFromClause(queryText) ?? {};
    }
```

- [ ] **Step 3: Wire the RPC handler**

In `extensions/mssql/src/queryResult/utils.ts`, add next to the `OpenGeneratedQueryRequest` handler (after line 292):

```typescript
webviewController.onRequest(qr.ResolveTableNameRequest.type, async (message) => {
    return await webviewViewController
        .getSqlOutputContentProvider()
        .resolveTableNameRequestHandler(message.uri, message.batchId);
});
```

- [ ] **Step 4: Typecheck**

Run: `cd extensions/mssql && npm run build:extension:typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/sharedInterfaces/queryResult.ts extensions/mssql/src/models/sqlOutputContentProvider.ts extensions/mssql/src/queryResult/utils.ts
git commit -m "feat: add resolveTableName RPC backed by FROM-clause parsing"
```

---

### Task 4: `sqlScriptGenerator.ts` fallback plumbing + tests

**Files:**

- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`
- Test: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`

**Interfaces:**

- Produces: `export interface FallbackTableName { tableName: string; schemaName?: string }`; updated signatures:
    - `buildQualifiedTableName(dbColumn: IDbColumn | undefined, fallback?: FallbackTableName): string`
    - `generateSelect(row, selectedColumnIndices, columns, dataProvider, columnInfo, fallback?: FallbackTableName): string`
    - `generateDelete(row, selectedColumnIndices, columns, dataProvider, columnInfo, fallback?: FallbackTableName): string`
    - `generateUpdate(row, selectedColumnIndices, columns, dataProvider, columnInfo, fallback?: FallbackTableName): string`
    - `generateInsertForRows(ranges, columns, dataProvider, columnInfo, fallback?: FallbackTableName): string`
      All used by Task 5 (`contextMenu.plugin.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`, inside the `buildQualifiedTableName` suite (after the existing two tests, before its closing `});` at line 89):

```typescript
test("uses fallback table name when baseTableName is empty", () => {
    expect(
        buildQualifiedTableName(makeDbCol("int"), { tableName: "Customers", schemaName: "dbo" }),
    ).to.equal("[dbo].[Customers]");
});

test("prefers baseTableName over fallback when both are present", () => {
    expect(
        buildQualifiedTableName(makeDbCol("int", "Id", "RealTable", "dbo"), {
            tableName: "FallbackTable",
            schemaName: "wrong",
        }),
    ).to.equal("[dbo].[RealTable]");
});
```

Add a new suite after the `generateInsertForRows` suite (after line 191, before the final closing `});` of the outer `suite("sqlScriptGenerator", ...)` at line 192):

```typescript
suite("fallback table name threading", () => {
    const columnInfo = [makeDbCol("nvarchar")]; // no baseTableName
    const cols = [makeCol(0, "Name")];
    const rows: CellRow[] = [{ "0": makeCell("Alice") }];
    const fallback = { tableName: "Customers", schemaName: "dbo" };

    test("generateSelect uses fallback table when columnInfo has none", () => {
        const provider = makeProvider(rows);
        const selected = getSelectedColumnIndices([makeRange(0, 0, 0, 0)], cols);
        const result = generateSelect(0, selected, cols, provider, columnInfo, fallback);
        expect(result).to.include("FROM [dbo].[Customers]");
    });

    test("generateUpdate uses fallback table when columnInfo has none", () => {
        const provider = makeProvider(rows);
        const selected = getSelectedColumnIndices([makeRange(0, 0, 0, 0)], cols);
        const result = generateUpdate(0, selected, cols, provider, columnInfo, fallback);
        expect(result).to.include("UPDATE [dbo].[Customers]");
    });

    test("generateDelete uses fallback table when columnInfo has none", () => {
        const provider = makeProvider(rows);
        const selected = getSelectedColumnIndices([makeRange(0, 0, 0, 0)], cols);
        const result = generateDelete(0, selected, cols, provider, columnInfo, fallback);
        expect(result).to.include("DELETE FROM [dbo].[Customers]");
    });

    test("generateInsertForRows uses fallback table when columnInfo has none", () => {
        const provider = makeProvider(rows);
        const result = generateInsertForRows(
            [makeRange(0, 0, 0, 0)],
            cols,
            provider,
            columnInfo,
            fallback,
        );
        expect(result).to.include("INSERT INTO [dbo].[Customers]");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extensions/mssql && npm test`
Expected: FAIL — new tests fail (fallback arg not yet accepted / table still resolves to `UnknownTable`).

- [ ] **Step 3: Implement the fallback plumbing**

In `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`, replace lines 136-144:

```typescript
export function buildQualifiedTableName(dbColumn: IDbColumn | undefined): string {
    if (!dbColumn?.baseTableName) {
        return "UnknownTable";
    }
    const table = escapeSqlIdentifier(dbColumn.baseTableName);
    return dbColumn.baseSchemaName
        ? `${escapeSqlIdentifier(dbColumn.baseSchemaName)}.${table}`
        : table;
}
```

with:

```typescript
export interface FallbackTableName {
    tableName: string;
    schemaName?: string;
}

export function buildQualifiedTableName(
    dbColumn: IDbColumn | undefined,
    fallback?: FallbackTableName,
): string {
    const tableName = dbColumn?.baseTableName || fallback?.tableName;
    if (!tableName) {
        return "UnknownTable";
    }
    const schemaName = dbColumn?.baseTableName ? dbColumn.baseSchemaName : fallback?.schemaName;
    const table = escapeSqlIdentifier(tableName);
    return schemaName ? `${escapeSqlIdentifier(schemaName)}.${table}` : table;
}
```

Then update the four call sites to accept and forward `fallback`:

```typescript
export function generateSelect<T extends Slick.SlickData>(
    row: number,
    selectedColumnIndices: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
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

export function generateDelete<T extends Slick.SlickData>(
    row: number,
    selectedColumnIndices: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string {
    const eol = getEOL();
    const wherePairs = getRowPairs(selectedColumnIndices, row, columns, dataProvider, columnInfo);
    const table = buildQualifiedTableName(wherePairs[0]?.dbColumn, fallback);
    return `DELETE FROM ${table}${eol}WHERE ${buildWhereClause(wherePairs)};`;
}

export function generateUpdate<T extends Slick.SlickData>(
    row: number,
    selectedColumnIndices: number[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
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
```

And `generateInsertForRows` (add the parameter and forward it at the `buildQualifiedTableName` call):

```typescript
export function generateInsertForRows<T extends Slick.SlickData>(
    ranges: ISlickRange[],
    columns: Slick.Column<T>[],
    dataProvider: IDisposableDataProvider<T>,
    columnInfo: IDbColumn[],
    fallback?: FallbackTableName,
): string {
```

(only the signature and the `buildQualifiedTableName(colMeta[0]?.dbColumn, fallback)` call change; the rest of the function body is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extensions/mssql && npm test`
Expected: PASS, all `sqlScriptGenerator` tests green, no regressions.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/common/sqlScriptGenerator.ts extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts
git commit -m "feat: thread optional fallback table name through SQL generators"
```

---

### Task 5: Wire `contextMenu.plugin.ts` to request and use the resolved table name

**Files:**

- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`

**Interfaces:**

- Consumes: `qr.ResolveTableNameRequest` (Task 3), `generateSelect`/`generateUpdate`/`generateDelete`/`generateInsertForRows` with `fallback?: FallbackTableName` (Task 4).

- [ ] **Step 1: Add the import**

Add `ResolveTableNameRequest` to the import from `"../../../../../sharedInterfaces/queryResult"` (contextMenu.plugin.ts:6-16):

```typescript
import {
    CopyAsCsvRequest,
    CopyAsJsonRequest,
    CopyAsInClauseRequest,
    CopyAsInsertIntoRequest,
    CopyHeadersRequest,
    CopySelectionRequest,
    GridContextMenuAction,
    OpenGeneratedQueryRequest,
    ResolveTableNameRequest,
    ResultSetSummary,
} from "../../../../../sharedInterfaces/queryResult";
```

- [ ] **Step 2: Resolve the fallback before building SQL**

Replace the `GenerateSelect`/`GenerateUpdate`/`GenerateDelete`/`GenerateInsert` case block (contextMenu.plugin.ts:194-250):

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
                if (!isSingleRowSelection(dataSelection)) {
                    log.warn("Generate query actions require a single-row selection");
                    break;
                }
                const [range] = dataSelection;
                const dataProvider = this.grid.getData() as IDisposableDataProvider<T>;
                const columnInfo = this.resultSetSummary.columnInfo;
                const row = range.fromRow;
                const selectedColumnIndices = getSelectedColumnIndices([range], gridColumns);

                const resolved = await this.queryResultContext.extensionRpc.sendRequest(
                    ResolveTableNameRequest.type,
                    { uri: this.uri, batchId: this.resultSetSummary.batchId },
                );
                const fallback = resolved.tableName
                    ? { tableName: resolved.tableName, schemaName: resolved.schemaName }
                    : undefined;

                let sql: string;
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

- [ ] **Step 3: Typecheck**

Run: `cd extensions/mssql && npx tsgo -p tsconfig.extension.json --noEmit` and `npx tsgo -p tsconfig.webviews.json --noEmit`
Expected: no new errors. (Per spec §3/§4, use `tsgo`, not plain `tsc`, to match what `npm run build` actually checks.)

- [ ] **Step 4: Manual verification**

Per spec §"OPEN ISSUE", this is the exact scenario that was broken. In the Extension Development Host (F5), on the **legacy** results grid (`mssql.preview.betaResultsGrid: false`):

1. Run `SELECT * FROM dbo.SomeTable` (a real single-table query).
2. Right-click a row → Generate SELECT.
3. Confirm the opened editor shows `FROM [dbo].[SomeTable]`, not `FROM UnknownTable`.
4. Repeat for Generate UPDATE/DELETE/INSERT.
5. Run a query with a `JOIN` and confirm it still falls back to `UnknownTable` (no false positive).

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts
git commit -m "feat: resolve real table name via FROM-clause parsing for grid-generated SQL"
```

---

## Self-Review Notes

- **Spec coverage:** Spec's chosen option 2 ("client-side fallback... parse the table name out of the query's FROM clause text for the single-table case") is implemented end-to-end: parser (Task 1) → host access to query text (Task 2) → RPC (Task 3) → generator plumbing (Task 4) → UI wiring (Task 5). Multi-table/JOIN case (spec's "documented edge case") intentionally still falls back to `UnknownTable` — verified by parser tests and Task 5 Step 4 manual check.
- **Type consistency:** `FallbackTableName` (Task 4) and `ResolveTableNameResponse` (Task 3) intentionally have slightly different shapes (`ResolveTableNameResponse` fields are both optional since "no match" is a valid response) — Task 5 Step 2 shows the exact conversion between them.
- **No STS/C# changes** anywhere in this plan, per constraint.
