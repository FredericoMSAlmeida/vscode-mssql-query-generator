# Generate Query Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two correctness/efficiency issues flagged by GitHub Copilot's review on an (accidentally-opened, since closed by the maintainer) upstream PR: `getBatchQueryText` ignoring `batchId` when an executed-query snapshot exists, and `ResolveTableNameRequest` firing unconditionally even when column metadata already has the table name.

**Architecture:** Both fixes are localized, no new files needed. Task 1 changes `QueryRunner.getBatchQueryText`'s branching. Task 2 adds one small shared predicate to `sqlScriptGenerator.ts` (already the grid-agnostic home for Generate-query logic) and uses it to gate the RPC call in both the legacy grid's `contextMenu.plugin.ts` and the Fluent grid's `fluentGenerateQuery.ts`, keeping the two ports consistent.

**Tech Stack:** TypeScript, mocha/chai/sinon (`vscode-test` unit test harness).

**Origin:** Copilot review comments on a since-closed upstream PR (maintainer redirected the overall feature idea to SQL Tools Service, but these two comments are independent, valid client-side issues in the current code):

1. `extensions/mssql/src/controllers/queryRunner.ts:1526-1546` (`getBatchQueryText`)
2. `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts:226-232` (unconditional `ResolveTableNameRequest`)

## Global Constraints

- Task 1 and Task 2 are independent — either can be implemented and shipped alone.
- Task 2 must fix both the legacy grid path (`contextMenu.plugin.ts`) and the Fluent grid path (`fluentGenerateQuery.ts`'s `dispatchFluentGenerateCommand`, added in the previous session's porting work) so the two don't drift back out of parity.
- Do not touch SQL Tools Service or attempt the "move this feature server-side" suggestion from the maintainer — that's a separate, unscoped decision for later (whether to file a sqltoolsservice feature request), not part of this plan.
- Preserve `getBatchQueryText`'s existing safety property for the common (single-batch) case: prefer the executed-text snapshot over re-reading the live document, since the live document may have been edited since the query ran.

---

## File Structure

- Modify: `extensions/mssql/src/controllers/queryRunner.ts` — `getBatchQueryText` only uses the snapshot when there's a single batch.
- Modify: `extensions/mssql/test/unit/queryRunner.test.ts` — tests for the above.
- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts` — add `needsTableNameFallback(columnInfo: IDbColumn[]): boolean`.
- Modify: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts` — tests for the above.
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts` — gate `ResolveTableNameRequest` on `needsTableNameFallback`.
- Modify: `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts` — test for the skip case.
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts` — gate `resolveTableName()` on `needsTableNameFallback` in `dispatchFluentGenerateCommand`.
- Modify: `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts` — test for the skip case.

---

### Task 1: `getBatchQueryText` — only use the snapshot for single-batch runs

**Files:**

- Modify: `extensions/mssql/src/controllers/queryRunner.ts`
- Test: `extensions/mssql/test/unit/queryRunner.test.ts`

**Interfaces:**

- No signature change: `getBatchQueryText(batchId: number): Promise<string | undefined>` behavior only.

- [ ] **Step 1: Write the failing test**

Add to `extensions/mssql/test/unit/queryRunner.test.ts`, in a new `suite("getBatchQueryText", ...)` block placed after the existing top-level tests (e.g. right before `suite("Copy Results", ...)` at line 899):

```typescript
suite("getBatchQueryText", () => {
    function makeBatchSummary(
        overrides: Partial<Contracts.BatchSummary> = {},
    ): Contracts.BatchSummary {
        return {
            executionElapsed: null,
            executionEnd: null,
            executionStart: new Date().toISOString(),
            hasError: false,
            id: 0,
            selection: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 20 },
            resultSetSummaries: [],
            ...overrides,
        };
    }

    test("returns the executed-query snapshot when there is only one batch", async () => {
        const queryRunner = createQueryRunner();
        queryRunner["_uriToQueryStringMap"].set(standardUri, "SELECT * FROM dbo.Orders");
        queryRunner.batchSets[0] = makeBatchSummary();

        const text = await queryRunner.getBatchQueryText(0);

        expect(text).to.equal("SELECT * FROM dbo.Orders");
        expect(vscodeWorkspace.openTextDocument).to.not.have.been.called;
    });

    test("reads the live document sliced by batch selection when there are multiple batches", async () => {
        const queryRunner = createQueryRunner();
        queryRunner["_uriToQueryStringMap"].set(
            standardUri,
            "SELECT * FROM dbo.Orders;\r\nSELECT * FROM dbo.Customers;",
        );
        queryRunner.batchSets[0] = makeBatchSummary({
            id: 0,
            selection: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 26 },
        });
        queryRunner.batchSets[1] = makeBatchSummary({
            id: 1,
            selection: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 28 },
        });
        const testDoc = {
            getText: (range: vscode.Range) =>
                range.start.line === 0
                    ? "SELECT * FROM dbo.Orders;"
                    : "SELECT * FROM dbo.Customers;",
        } as unknown as vscode.TextDocument;
        vscodeWorkspace.openTextDocument.resolves(testDoc);

        const text = await queryRunner.getBatchQueryText(1);

        expect(text).to.equal("SELECT * FROM dbo.Customers;");
        expect(vscodeWorkspace.openTextDocument).to.have.been.calledOnce;
    });

    test("returns undefined when the batch does not exist", async () => {
        const queryRunner = createQueryRunner();
        expect(await queryRunner.getBatchQueryText(0)).to.equal(undefined);
    });
});
```

Add `Contracts` to the existing `import * as QueryExecuteContracts from "../../src/models/contracts/queryExecute";`-style imports if `BatchSummary` isn't already imported under some alias — check the top of the file first; if `BatchSummary`'s type is already reachable (the existing batch-literal tests at line 326 don't import a type name at all, they rely on structural typing against `queryRunner.batchSets[0] = {...}`), skip the explicit `Partial<Contracts.BatchSummary>` typing and inline the object literal shape instead, matching the existing untyped-literal style used elsewhere in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `extensions/mssql`): `npm run pretest && npx vscode-test -l "Unit Tests" -g "getBatchQueryText"`
Expected: FAIL — the second test ("multiple batches") fails because current code returns the whole snapshot string instead of the sliced batch text.

- [ ] **Step 3: Implement the fix**

In `extensions/mssql/src/controllers/queryRunner.ts`, replace:

```typescript
    public async getBatchQueryText(batchId: number): Promise<string | undefined> {
        const batchSummary = this.batchSets[batchId];
        if (!batchSummary) {
            return undefined;
        }
        // Prefer the snapshot of the text that was actually executed for this run.
        // Re-reading the live document here would risk parsing text the user has
        // since edited but not re-run, which could resolve to a table that has
        // nothing to do with the grid's actual data.
        const executedQueryString = this.getQueryString(this._ownerUri);
        if (executedQueryString !== undefined) {
            return executedQueryString;
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

with:

```typescript
    public async getBatchQueryText(batchId: number): Promise<string | undefined> {
        const batchSummary = this.batchSets[batchId];
        if (!batchSummary) {
            return undefined;
        }
        // Prefer the snapshot of the text that was actually executed for this run,
        // but only when there's a single batch — with multiple batches the snapshot
        // is every batch concatenated, which isn't this batch's text. Re-reading the
        // live document in the multi-batch case risks parsing text the user has since
        // edited but not re-run, but that's still more accurate than the wrong batch.
        const isSingleBatch = this.batchSets.filter((b) => !!b).length <= 1;
        if (isSingleBatch) {
            const executedQueryString = this.getQueryString(this._ownerUri);
            if (executedQueryString !== undefined) {
                return executedQueryString;
            }
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vscode-test -l "Unit Tests" -g "getBatchQueryText"`
Expected: PASS, all 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add extensions/mssql/src/controllers/queryRunner.ts extensions/mssql/test/unit/queryRunner.test.ts
git commit -m "fix: resolve table name from the correct batch in multi-batch scripts"
```

---

### Task 2: Skip `ResolveTableNameRequest` when metadata already has the table name

**Files:**

- Modify: `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`
- Test: `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts`
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`
- Test: `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`
- Modify: `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts`
- Test: `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts`

**Interfaces:**

- Produces: `needsTableNameFallback(columnInfo: IDbColumn[]): boolean` in `sqlScriptGenerator.ts` — consumed by both the legacy and Fluent dispatch sites below.

- [ ] **Step 1: Write the failing test for the new predicate**

Add to `extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts` (add `needsTableNameFallback` to the existing import list from `sqlScriptGenerator`), a new suite:

```typescript
suite("needsTableNameFallback", () => {
    test("false when every column already has a base table name", () => {
        expect(
            needsTableNameFallback([
                makeDbCol("int", "Id", "Customers", "dbo"),
                makeDbCol("nvarchar", "Name", "Customers", "dbo"),
            ]),
        ).to.equal(false);
    });

    test("true when any column is missing a base table name", () => {
        expect(
            needsTableNameFallback([
                makeDbCol("int", "Id", "Customers", "dbo"),
                makeDbCol("nvarchar", "Total"),
            ]),
        ).to.equal(true);
    });

    test("true for an empty column list", () => {
        expect(needsTableNameFallback([])).to.equal(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vscode-test -l "Unit Tests" -g "needsTableNameFallback"`
Expected: FAIL — compile error, `needsTableNameFallback` doesn't exist yet.

- [ ] **Step 3: Implement the predicate**

In `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`, add right after `buildQualifiedTableName`:

```typescript
export function needsTableNameFallback(columnInfo: IDbColumn[]): boolean {
    return columnInfo.length === 0 || columnInfo.some((col) => !col.baseTableName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vscode-test -l "Unit Tests" -g "needsTableNameFallback"`
Expected: PASS.

- [ ] **Step 5: Gate the legacy grid's RPC call**

Write the failing test first, in `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`: add a test asserting `ResolveTableNameRequest` is NOT sent when `columnInfo` already has `baseTableName` for every column. Follow the existing file's pattern (`makeGridAndContext`, stubbed `sendRequest`) — locate the existing single-row `GenerateSelect` test (it currently sends `ResolveTableNameRequest` as part of its flow) and add a sibling test:

```typescript
test("GenerateSelect skips ResolveTableNameRequest when columnInfo already has the table name", async () => {
    const { grid, queryResultContext, sendRequest } = makeGridAndContext([makeRange(0, 0, 0, 0)]);
    const menu = new ContextMenu<Slick.SlickData>(
        "file:///test.sql",
        {
            batchId: 0,
            id: 0,
            rowCount: 1,
            columnInfo: columnInfo.map((c) => ({
                ...c,
                baseTableName: "Customers",
                baseSchemaName: "dbo",
            })),
        } as ResultSetSummary,
        queryResultContext,
    );
    menu.init(grid as unknown as Slick.Grid<Slick.SlickData>);
    await (
        menu as unknown as { handleMenuAction: (a: GridContextMenuAction) => Promise<void> }
    ).handleMenuAction(GridContextMenuAction.GenerateSelect);

    expect(sendRequest.getCalls().some((c) => c.args[0] === ResolveTableNameRequest.type)).to.equal(
        false,
    );
});
```

(Check the file's existing `columnInfo` fixture name/shape and adjust the `.map` above to match exactly — the goal is a `columnInfo` array where every entry already has a non-empty `baseTableName`.)

Run: `npx vscode-test -l "Unit Tests" -g "skips ResolveTableNameRequest"` — expect FAIL (current code always sends it).

Then in `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`, add `needsTableNameFallback` to the import from `sqlScriptGenerator`, and replace:

```typescript
const resolved = await this.queryResultContext.extensionRpc.sendRequest(
    ResolveTableNameRequest.type,
    { uri: this.uri, batchId: this.resultSetSummary.batchId },
);
const fallback = resolved.tableName
    ? { tableName: resolved.tableName, schemaName: resolved.schemaName }
    : undefined;
```

with:

```typescript
let fallback: { tableName: string; schemaName?: string } | undefined;
if (needsTableNameFallback(columnInfo)) {
    const resolved = await this.queryResultContext.extensionRpc.sendRequest(
        ResolveTableNameRequest.type,
        { uri: this.uri, batchId: this.resultSetSummary.batchId },
    );
    fallback = resolved.tableName
        ? { tableName: resolved.tableName, schemaName: resolved.schemaName }
        : undefined;
}
```

Run the test again: expect PASS. Then run the full `contextMenu.plugin.test.ts` suite to confirm the pre-existing tests (which use a `columnInfo` fixture presumably missing `baseTableName`, since that's the whole point of the earlier table-name-fallback feature) still pass unchanged — they should, since `needsTableNameFallback` returns `true` for them and the RPC still fires.

Run: `npx vscode-test -l "Unit Tests" -g "contextMenu"`
Expected: PASS, no regressions.

- [ ] **Step 6: Gate the Fluent grid's RPC call**

Write the failing test first, in `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts`, in the `dispatchFluentGenerateCommand` suite:

```typescript
test("skips resolveTableName when columnInfo already has the table name", async () => {
    const resolveTableName = async () => ({ tableName: undefined, schemaName: undefined });
    const resolveTableNameSpy = { calls: 0 };
    const openedSql: string[] = [];

    await dispatchFluentGenerateCommand({
        action: "select",
        ranges: [{ fromRow: 0, toRow: 0, fromCell: 0, toCell: 0 }],
        columnInfo,
        rowAccessor: provider,
        resolveTableName: async () => {
            resolveTableNameSpy.calls++;
            return resolveTableName();
        },
        openGeneratedQuery: async (sql) => {
            openedSql.push(sql);
        },
        warn: () => {},
    });

    expect(resolveTableNameSpy.calls).to.equal(0);
    expect(openedSql.length).to.equal(1);
});
```

(`columnInfo`/`provider` here are the ones already defined at the top of the `dispatchFluentGenerateCommand` suite in this file, which already have `baseTableName: "Customers"` set on every entry — reuse them rather than redefining.)

Run: `npx vscode-test -l "Unit Tests" -g "skips resolveTableName"` — expect FAIL.

Then in `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts`, add `needsTableNameFallback` to the import from `../../common/sqlScriptGenerator`, and replace:

```typescript
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
```

with:

```typescript
export async function dispatchFluentGenerateCommand({
    action,
    ranges,
    columnInfo,
    rowAccessor,
    resolveTableName,
    openGeneratedQuery,
    warn,
}: DispatchFluentGenerateCommandOptions): Promise<void> {
    let fallback: FallbackTableName | undefined;
    if (needsTableNameFallback(columnInfo)) {
        const resolved = await resolveTableName();
        fallback = resolved.tableName
            ? { tableName: resolved.tableName, schemaName: resolved.schemaName }
            : undefined;
    }

    const sql = resolveFluentGeneratedSql(action, ranges, columnInfo, rowAccessor, fallback);
```

Run: `npx vscode-test -l "Unit Tests" -g "fluentGenerateQuery"`
Expected: PASS, all tests in the file green including the pre-existing ones (their `columnInfo` fixtures already have `baseTableName` set, so double-check whether any of those tests asserted `resolveTableName` WAS called — if so, that assertion still holds since those tests don't inspect call counts, only final SQL/warn output, so they're unaffected either way).

- [ ] **Step 7: Full regression check**

Run: `npx vscode-test -l "Unit Tests"`
Expected: same baseline as before this plan (all green except the pre-existing, unrelated `queryCompletionSoundService` audio/spawn failures).

- [ ] **Step 8: Commit**

```bash
git add extensions/mssql/src/webviews/common/sqlScriptGenerator.ts extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts
git commit -m "perf: skip ResolveTableNameRequest when column metadata already has the table name"
```

---

## Self-Review Notes

- **Spec coverage:** both Copilot comments map 1:1 to a task. Task 2 explicitly covers both the legacy grid (where the comment was originally raised) and the Fluent grid (not mentioned by Copilot, since that port didn't exist yet when the PR was reviewed, but has the identical issue).
- **Risk containment:** Task 1's fix only changes behavior for the multi-batch case (previously wrong); the single-batch case — the overwhelming majority of usage — is byte-for-byte unchanged (same snapshot-preferred branch, same early return).
- **Type consistency:** `needsTableNameFallback(columnInfo: IDbColumn[]): boolean` is defined once in `sqlScriptGenerator.ts` and imported unchanged by both consumers — no risk of the two grids' fallback-gating logic drifting apart the way the RPC-always-fires behavior already had before this plan.
- Not in scope: deciding whether to file the sqltoolsservice feature request the maintainer suggested — that's a separate follow-up decision, not a coding task.
