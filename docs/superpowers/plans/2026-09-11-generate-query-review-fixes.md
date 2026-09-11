# Generate Query Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Execution mode: batched, not per-step TDD.** Write all code for both fixes (implementation + tests) first, then run the unit test suite once at the end. Only re-run tests if that first run surfaces failures — don't run the full `vscode-test` extension-host suite after every individual step, it's slow (~2-10 min per invocation).

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
- **Verification is batched at the end, not per-step** — write all code first (both fixes, both sets of tests), then run tests once. Re-run only what's needed to confirm a fix if the first run finds failures.

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

### Task 1: Write both fixes — implementation and tests, no intermediate test runs

**Files:** all files listed in File Structure above.

**Interfaces:**

- Produces: `needsTableNameFallback(columnInfo: IDbColumn[]): boolean` in `sqlScriptGenerator.ts` — consumed by both the legacy and Fluent dispatch sites.
- No signature change to `getBatchQueryText(batchId: number): Promise<string | undefined>` — behavior only.

- [ ] **Step 1: `getBatchQueryText` — implementation**

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

- [ ] **Step 2: `getBatchQueryText` — tests**

Add to `extensions/mssql/test/unit/queryRunner.test.ts`, in a new `suite("getBatchQueryText", ...)` block placed after the existing top-level tests (e.g. right before `suite("Copy Results", ...)` at line 899):

```typescript
suite("getBatchQueryText", () => {
    function makeBatchSummary(overrides: Record<string, unknown> = {}) {
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

Use plain object literals (no imported `BatchSummary` type) for `makeBatchSummary`, matching the existing untyped-literal style already used for `queryRunner.batchSets[0] = {...}` at line 326 of this file.

- [ ] **Step 3: `needsTableNameFallback` — implementation**

In `extensions/mssql/src/webviews/common/sqlScriptGenerator.ts`, add right after `buildQualifiedTableName`:

```typescript
export function needsTableNameFallback(columnInfo: IDbColumn[]): boolean {
    return columnInfo.length === 0 || columnInfo.some((col) => !col.baseTableName);
}
```

- [ ] **Step 4: `needsTableNameFallback` — tests**

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

- [ ] **Step 5: Gate the legacy grid's RPC call — implementation**

In `extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts`, add `needsTableNameFallback` to the import from `sqlScriptGenerator`, and replace:

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

- [ ] **Step 6: Gate the legacy grid's RPC call — test**

In `extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts`, add `ResolveTableNameRequest` and `needsTableNameFallback`'s effect via a new test next to the existing single-row `GenerateSelect` test. First inspect the file's existing `columnInfo` fixture (used across its tests) to see whether it already has `baseTableName` populated or not, then write:

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

Adjust the `columnInfo` fixture reference/`.map` to match whatever the file's actual existing fixture is named and shaped — the goal is simply an array where every entry ends up with a non-empty `baseTableName`. The pre-existing tests in this file should be using a `columnInfo` fixture that's missing `baseTableName` (that's the premise of the original table-name-fallback feature) — leave those untouched; they'll still exercise the RPC-fires path since `needsTableNameFallback` returns `true` for them.

- [ ] **Step 7: Gate the Fluent grid's RPC call — implementation**

In `extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts`, add `needsTableNameFallback` to the import from `../../common/sqlScriptGenerator`, and replace:

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

- [ ] **Step 8: Gate the Fluent grid's RPC call — test**

In `extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts`, in the `dispatchFluentGenerateCommand` suite, add:

```typescript
test("skips resolveTableName when columnInfo already has the table name", async () => {
    let resolveTableNameCalls = 0;
    const openedSql: string[] = [];

    await dispatchFluentGenerateCommand({
        action: "select",
        ranges: [{ fromRow: 0, toRow: 0, fromCell: 0, toCell: 0 }],
        columnInfo,
        rowAccessor: provider,
        resolveTableName: async () => {
            resolveTableNameCalls++;
            return { tableName: undefined, schemaName: undefined };
        },
        openGeneratedQuery: async (sql) => {
            openedSql.push(sql);
        },
        warn: () => {},
    });

    expect(resolveTableNameCalls).to.equal(0);
    expect(openedSql.length).to.equal(1);
});
```

(`columnInfo`/`provider` are the ones already defined at the top of the `dispatchFluentGenerateCommand` suite, which already have `baseTableName: "Customers"` set on every entry — reuse them rather than redefining.)

---

### Task 2: Verify everything at once

- [ ] **Step 1: Run the targeted tests**

Run (from `extensions/mssql`):

```bash
npm run pretest
npx vscode-test -l "Unit Tests" -g "getBatchQueryText|needsTableNameFallback|contextMenu|fluentGenerateQuery"
```

Expected: all suites green — the new tests plus every pre-existing test in the touched files.

- [ ] **Step 2: Fix any failures**

If anything fails, fix it and re-run only the relevant `-g` filter (not the full suite) until green. Common things to double check if red:

- `contextMenu.plugin.test.ts`'s actual `columnInfo` fixture name/shape (Step 6 above flags this as needing verification against the real file).
- Whether `Slick.SlickData`/`GeneratorColumn` typing still lines up after the `let fallback: {...} | undefined;` type annotation in `contextMenu.plugin.ts` — align it with `FallbackTableName` from `sqlScriptGenerator.ts` if that's cleaner than the inline object type shown above.

- [ ] **Step 3: Full regression check**

Run: `npx vscode-test -l "Unit Tests"`
Expected: same baseline as before this plan (all green except the pre-existing, unrelated `queryCompletionSoundService` audio/spawn failures).

- [ ] **Step 4: Commit**

```bash
git add extensions/mssql/src/controllers/queryRunner.ts extensions/mssql/test/unit/queryRunner.test.ts extensions/mssql/src/webviews/common/sqlScriptGenerator.ts extensions/mssql/test/unit/webviews/sqlScriptGenerator.test.ts extensions/mssql/src/webviews/pages/QueryResult/table/plugins/contextMenu.plugin.ts extensions/mssql/test/unit/webviews/contextMenu.plugin.test.ts extensions/mssql/src/webviews/pages/QueryResult/fluentGenerateQuery.ts extensions/mssql/test/unit/webviews/fluentGenerateQuery.test.ts
git commit -m "fix: resolve table name from the correct batch and skip redundant RPC lookups"
```

---

## Self-Review Notes

- **Spec coverage:** both Copilot comments map 1:1 to implementation steps (Step 1 and Steps 5+7). Task covers both the legacy grid (where the comment was originally raised) and the Fluent grid (not mentioned by Copilot, since that port didn't exist yet when the PR was reviewed, but has the identical issue).
- **Risk containment:** Task 1 Step 1's fix only changes behavior for the multi-batch case (previously wrong); the single-batch case — the overwhelming majority of usage — is byte-for-byte unchanged (same snapshot-preferred branch, same early return).
- **Type consistency:** `needsTableNameFallback(columnInfo: IDbColumn[]): boolean` is defined once in `sqlScriptGenerator.ts` and imported unchanged by both consumers — no risk of the two grids' fallback-gating logic drifting apart the way the RPC-always-fires behavior already had before this plan.
- Not in scope: deciding whether to file the sqltoolsservice feature request the maintainer suggested — that's a separate follow-up decision, not a coding task.
