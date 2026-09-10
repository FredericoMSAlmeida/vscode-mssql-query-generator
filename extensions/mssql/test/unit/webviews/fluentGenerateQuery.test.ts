/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect } from "chai";
import type { IDbColumn } from "vscode-mssql";
import type { ISlickRange } from "../../../src/sharedInterfaces/queryResult";
import type { GeneratorDataProvider } from "../../../src/webviews/common/sqlScriptGenerator";
import {
    buildGeneratorColumnsFromColumnInfo,
    dispatchFluentGenerateCommand,
    isFluentGenerateInsertVisible,
    isFluentGenerateRowActionsVisible,
    resolveFluentGeneratedSql,
} from "../../../src/webviews/pages/QueryResult/fluentGenerateQuery";

function makeDbCol(columnName: string): IDbColumn {
    return { columnName } as IDbColumn;
}

function makeRange(fromRow: number, toRow: number, fromCell: number, toCell: number): ISlickRange {
    return { fromRow, toRow, fromCell, toCell };
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
    } else {
        delete (globalThis as any)[name];
    }
}

suite("fluentGenerateQuery", () => {
    let navigatorDescriptor: PropertyDescriptor | undefined;

    suiteSetup(() => {
        navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
        Object.defineProperty(globalThis, "navigator", {
            value: {
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            },
            configurable: true,
        });
    });

    suiteTeardown(() => {
        restoreProperty("navigator", navigatorDescriptor);
    });

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

    suite("resolveFluentGeneratedSql", () => {
        const columnInfo = [
            {
                columnName: "Id",
                baseColumnName: "Id",
                baseTableName: "Customers",
                baseSchemaName: "dbo",
                dataTypeName: "int",
            } as IDbColumn,
            {
                columnName: "Name",
                baseColumnName: "Name",
                baseTableName: "Customers",
                baseSchemaName: "dbo",
                dataTypeName: "nvarchar",
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
            expect(sql).to.equal(
                "SELECT [Id], [Name]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] = 1;",
            );
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
                dataTypeName: "int",
            } as IDbColumn,
            {
                columnName: "Name",
                baseColumnName: "Name",
                baseTableName: "Customers",
                baseSchemaName: "dbo",
                dataTypeName: "nvarchar",
            } as IDbColumn,
        ];
        const provider: GeneratorDataProvider = {
            getItem: () => ({
                "0": { displayValue: "1", isNull: false },
                "1": { displayValue: "Alice", isNull: false },
            }),
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
                "SELECT [Id], [Name]\r\nFROM [dbo].[Customers]\r\nWHERE [Id] = 1;",
            ]);
            expect(warnings).to.deep.equal([]);
        });

        test("warns instead of opening when no SQL can be generated", async () => {
            const openedSql: string[] = [];
            const warnings: string[] = [];

            await dispatchFluentGenerateCommand({
                action: "select",
                ranges: [{ fromRow: 0, toRow: 1, fromCell: 0, toCell: 1 }],
                columnInfo: [
                    { columnName: "Id" } as IDbColumn,
                    { columnName: "Name" } as IDbColumn,
                ],
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
});
