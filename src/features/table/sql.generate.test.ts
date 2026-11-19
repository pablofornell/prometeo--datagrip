// @vitest-environment node
/** `Generate SQL` of the grid row menu: one statement per row, the key in the WHERE, quoting and literals of the dialect. */
import { describe, expect, it } from "vitest";
import type { ObjectRef } from "../../api/types";
import type { Cell } from "../../components/grid/types";
import { type RowSqlColumn, rowStatements, sqlCopiedNotice } from "./sql";

const ref = (name: string, schema: string | null = "shop"): ObjectRef => ({ schema, name, kind: "table" });
const cols: RowSqlColumn[] = [
  { name: "id", typeName: "int4", isPk: true },
  { name: "name", typeName: "text" },
  { name: "born", typeName: "date" },
];
const noKey: RowSqlColumn[] = cols.map((c) => ({ ...c, isPk: false }));
const row: Cell[] = [7, "O'Brien", "2020-01-31"];

describe("rowStatements, table with a primary key", () => {
  it("PostgreSQL: select, insert, update, delete", () => {
    expect(rowStatements("postgres", ref("clients"), "select", cols, [row])).toEqual([`SELECT *\nFROM shop.clients\nWHERE id = 7;`]);
    expect(rowStatements("postgres", ref("clients"), "insert", cols, [row])).toEqual([
      `INSERT INTO shop.clients (id, name, born)\nVALUES (7, 'O''Brien', '2020-01-31');`,
    ]);
    expect(rowStatements("postgres", ref("clients"), "update", cols, [row])).toEqual([
      `UPDATE shop.clients\nSET name = 'O''Brien',\n    born = '2020-01-31'\nWHERE id = 7;`,
    ]);
    expect(rowStatements("postgres", ref("clients"), "delete", cols, [row])).toEqual([`DELETE\nFROM shop.clients\nWHERE id = 7;`]);
  });

  it("MySQL: backtick quoting for reserved words, backslashes doubled in strings", () => {
    const c: RowSqlColumn[] = [
      { name: "id", typeName: "int", isPk: true },
      { name: "order", typeName: "varchar(20)" },
    ];
    expect(rowStatements("mysql", ref("group", "demo"), "update", c, [[1, "C:\\temp"]])).toEqual([
      "UPDATE demo.`group`\nSET `order` = 'C:\\\\temp'\nWHERE id = 1;",
    ]);
    expect(rowStatements("mysql", ref("group", "demo"), "insert", c, [[1, "x"]])).toEqual(["INSERT INTO demo.`group` (id, `order`)\nVALUES (1, 'x');"]);
  });

  it("Oracle: upper case names, DATE and TIMESTAMP literals, no boolean", () => {
    const c: RowSqlColumn[] = [
      { name: "ID", typeName: "NUMBER", isPk: true },
      { name: "BORN", typeName: "DATE" },
      { name: "SEEN", typeName: "TIMESTAMP(6)" },
      { name: "OK", typeName: "NUMBER(1)" },
    ];
    const r: Cell[] = [3, "2020-01-31", "2020-01-31 10:20:30.5", true];
    expect(rowStatements("oracle", ref("CLIENTS", "APP"), "insert", c, [r])).toEqual([
      `INSERT INTO APP.CLIENTS (ID, BORN, SEEN, OK)\nVALUES (3, date '2020-01-31', timestamp '2020-01-31 10:20:30.5', 1);`,
    ]);
    expect(rowStatements("oracle", ref("CLIENTS", "APP"), "update", c, [r])[0]).toBe(
      `UPDATE APP.CLIENTS\nSET BORN = date '2020-01-31',\n    SEEN = timestamp '2020-01-31 10:20:30.5',\n    OK = 1\nWHERE ID = 3;`,
    );
  });

  it("binary values", () => {
    const c: RowSqlColumn[] = [
      { name: "id", typeName: "integer", isPk: true },
      { name: "img", typeName: "blob" },
    ];
    expect(rowStatements("sqlite", ref("pics", "main"), "insert", c, [[1, { $bin: "ab01" }]])).toEqual([`INSERT INTO main.pics (id, img)\nVALUES (1, X'ab01');`]);
    expect(rowStatements("postgres", ref("pics"), "insert", c, [[1, { $bin: "ab01" }]])[0]).toContain(`'\\xab01'`);
    expect(rowStatements("oracle", ref("PICS"), "insert", c, [[1, { $bin: "ab01" }]])[0]).toContain(`hextoraw('ab01')`);
  });

  it("NULLs are null values; booleans and numeric strings are not quoted", () => {
    const c: RowSqlColumn[] = [
      { name: "id", typeName: "int8", isPk: true },
      { name: "ok", typeName: "bool" },
      { name: "amount", typeName: "numeric" },
      { name: "note", typeName: "text" },
    ];
    expect(rowStatements("postgres", ref("t"), "insert", c, [[1, true, "12.50", null]])).toEqual([
      `INSERT INTO shop.t (id, ok, amount, note)\nVALUES (1, true, 12.50, null);`,
    ]);
    expect(rowStatements("postgres", ref("t"), "update", c, [[1, false, null, null]])[0]).toBe(
      `UPDATE shop.t\nSET ok = false,\n    amount = null,\n    note = null\nWHERE id = 1;`,
    );
  });

  it("a composite key puts every key column in the WHERE and not in the SET", () => {
    const c: RowSqlColumn[] = [
      { name: "a", typeName: "int4", isPk: true },
      { name: "b", typeName: "int4", isPk: true },
      { name: "v", typeName: "text" },
    ];
    expect(rowStatements("postgres", ref("t"), "update", c, [[1, 2, "x"]])[0]).toBe(`UPDATE shop.t\nSET v = 'x'\nWHERE a = 1 AND b = 2;`);
  });

  it("a table of key columns only sets them all", () => {
    const c: RowSqlColumn[] = [
      { name: "a", typeName: "int4", isPk: true },
      { name: "b", typeName: "int4", isPk: true },
    ];
    expect(rowStatements("postgres", ref("t"), "update", c, [[1, 2]])[0]).toBe(`UPDATE shop.t\nSET a = 1,\n    b = 2\nWHERE a = 1 AND b = 2;`);
  });

  it("one statement per row, in the order given; none for no rows", () => {
    expect(
      rowStatements("postgres", ref("t"), "delete", cols, [
        [1, "a", null],
        [2, "b", null],
      ]),
    ).toEqual([`DELETE\nFROM shop.t\nWHERE id = 1;`, `DELETE\nFROM shop.t\nWHERE id = 2;`]);
    expect(rowStatements("postgres", ref("t"), "select", cols, [])).toEqual([]);
  });

  it("a table without schema is not qualified; odd names are quoted", () => {
    expect(rowStatements("postgres", ref("My Table", null), "delete", cols, [row])[0]).toBe(`DELETE\nFROM "My Table"\nWHERE id = 7;`);
  });

  it("read-only columns (aliases, generated) are left out of INSERT", () => {
    const c: RowSqlColumn[] = [...cols, { name: "total", typeName: "int4", readOnly: true }];
    expect(rowStatements("postgres", ref("t"), "insert", c, [[...row, 99]])[0]).toBe(`INSERT INTO shop.t (id, name, born)\nVALUES (7, 'O''Brien', '2020-01-31');`);
  });
});

describe("rowStatements, table without a primary key", () => {
  it("every column is the key; NULLs use IS NULL", () => {
    const r: Cell[] = [7, null, "2020-01-31"];
    expect(rowStatements("postgres", ref("t"), "select", noKey, [r])).toEqual([`SELECT *\nFROM shop.t\nWHERE id = 7 AND name is null AND born = '2020-01-31';`]);
    expect(rowStatements("postgres", ref("t"), "delete", noKey, [r])).toEqual([`DELETE\nFROM shop.t\nWHERE id = 7 AND name is null AND born = '2020-01-31';`]);
  });

  it("UPDATE sets all the columns", () => {
    expect(rowStatements("mysql", ref("t", "demo"), "update", noKey, [[7, null, "2020-01-31"]])[0]).toBe(
      `UPDATE demo.t\nSET id = 7,\n    name = null,\n    born = '2020-01-31'\nWHERE id = 7 AND name is null AND born = '2020-01-31';`,
    );
  });

  it("Oracle: an empty string is NULL, so it is compared with IS NULL", () => {
    const c: RowSqlColumn[] = [
      { name: "ID", typeName: "NUMBER" },
      { name: "NAME", typeName: "VARCHAR2(10)" },
    ];
    expect(rowStatements("oracle", ref("T", "APP"), "delete", c, [[1, ""]])[0]).toBe(`DELETE\nFROM APP.T\nWHERE ID = 1 AND NAME is null;`);
  });

  it("INSERT lists all the columns", () => {
    expect(rowStatements("postgres", ref("t"), "insert", noKey, [[7, null, "2020-01-31"]])[0]).toBe(`INSERT INTO shop.t (id, name, born)\nVALUES (7, null, '2020-01-31');`);
  });
});

describe("sqlCopiedNotice", () => {
  it("counts the statements", () => {
    expect(sqlCopiedNotice("insert", 1)).toEqual({ title: "Copied 1 statement", body: "INSERT to the clipboard" });
    expect(sqlCopiedNotice("delete", 3).title).toBe("Copied 3 statements");
  });
});
