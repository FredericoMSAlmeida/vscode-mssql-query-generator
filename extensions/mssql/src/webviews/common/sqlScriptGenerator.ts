/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DbCellValue, IDbColumn, ISlickRange } from "../../sharedInterfaces/queryResult";
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

export interface GeneratorColumn {
    id?: string;
    field?: string;
    toolTip?: string;
    name?: string;
}

export interface GeneratorDataProvider {
    getItem(row: number): Slick.SlickData;
}

export function isNumericSqlType(dataTypeName: string | undefined): boolean {
    return !!dataTypeName && NUMERIC_SQL_TYPES.has(dataTypeName.toLowerCase());
}

export function sqlStr(v: string): string {
    return "'" + v.replace(/'/g, "''") + "'";
}

export function escapeSqlIdentifier(value: string): string {
    return `[${value.replaceAll("]", "]]")}]`;
}

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

export function isCellSelected(ranges: ISlickRange[], row: number, colIndex: number): boolean {
    return ranges.some(
        (rng) =>
            row >= rng.fromRow &&
            row <= rng.toRow &&
            colIndex >= rng.fromCell &&
            colIndex <= rng.toCell,
    );
}

export function isSingleRowSelection(ranges: ISlickRange[]): boolean {
    return ranges.length === 1 && ranges[0].fromRow === ranges[0].toRow;
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

function getSelectedRows(ranges: ISlickRange[]): number[] {
    const rows = new Set<number>();
    for (const range of ranges) {
        for (let r = range.fromRow; r <= range.toRow; r++) {
            rows.add(r);
        }
    }
    return [...rows].sort((a, b) => a - b);
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
