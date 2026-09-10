/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect } from "chai";
import type { IDbColumn } from "vscode-mssql";
import type { IDisposableDataProvider } from "../../../src/webviews/pages/QueryResult/table/dataProvider";
import {
    buildInClause,
    buildQualifiedTableName,
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
} from "../../../src/webviews/common/sqlScriptGenerator";

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
    } else {
        delete (globalThis as any)[name];
    }
}

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

    suite("buildQualifiedTableName", () => {
        test("falls back to UnknownTable when baseTableName is empty", () => {
            expect(buildQualifiedTableName(makeDbCol("int"))).to.equal("UnknownTable");
        });

        test("uses schema-qualified, escaped table name when present", () => {
            expect(buildQualifiedTableName(makeDbCol("int", "Id", "Order] Item", "dbo"))).to.equal(
                "[dbo].[Order]] Item]",
            );
        });

        test("uses fallback table name when baseTableName is empty", () => {
            expect(
                buildQualifiedTableName(makeDbCol("int"), {
                    tableName: "Customers",
                    schemaName: "dbo",
                }),
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
    });

    suite("buildInClause", () => {
        test("returns undefined for an empty pair list", () => {
            expect(buildInClause([])).to.equal(undefined);
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
});
