/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDbColumn, ISlickRange } from "../../../sharedInterfaces/queryResult";
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
    type FallbackTableName,
    type GeneratorColumn,
    type GeneratorDataProvider,
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
