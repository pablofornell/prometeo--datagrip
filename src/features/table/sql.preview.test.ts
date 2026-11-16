// @vitest-environment node
/** The pending-changes preview: the same quoting, literals and column order as the statements dbcore runs. */
import { describe, expect, it } from "vitest";
import type { ColumnMeta, Driver, ObjectRef } from "../../api/types";
import { DEFAULT_VALUE } from "../../components/grid/format";
import { type GridChange, NEW_ROW } from "../../components/grid/types";
import { changeStatements, literal, qualifiedName, quoteString } from "./sql";

const col = (name: string, typeName: string, isPk = false): ColumnMeta => ({ name, typeName, nullable: true, isPk, tableRef: "t" });
const ref = (name: string, schema = "shop"): ObjectRef => ({ schema, name, kind: "table" });
const insert = (values: GridChange["values"]): GridChange => ({ kind: "insert", row: NEW_ROW, key: {}, values });

describe("names that are keywords", () => {
  it("quotes a reserved word in every dialect, not only the ones with odd characters", () => {
    expect(qualifiedName("postgres", ref("order"))).toBe('shop."order"');
    expect(qualifiedName("postgres", ref("clients", "user"))).toBe('"user".clients');
    expect(qualifiedName("mysql", ref("group", "demo"))).toBe("demo.`group`");
    expect(qualifiedName("sqlite", ref("index", "main"))).toBe('main."index"');
    expect(qualifiedName("oracle", ref("ORDER", "DEMO"))).toBe('DEMO."ORDER"');
    // ordinary names stay bare
    expect(qualifiedName("postgres", ref("clients"))).toBe("shop.clients");
    expect(qualifiedName("oracle", ref("CLIENTS", "DEMO"))).toBe("DEMO.CLIENTS");
  });

  it("quotes a column called like a keyword in the preview", () => {
    const cols = [col("id", "int4", true), col("select", "text"), col("user", "text")];
    const [stmt] = changeStatements("postgres", ref("t"), cols, [{ kind: "update", row: 0, key: { id: 1 }, values: { select: "a", user: "b" } }]);
    expect(stmt).toBe(`UPDATE shop.t\nSET "select" = 'a',\n    "user" = 'b'\nWHERE id = 1;`);
  });
});

describe("literals", () => {
  it("writes a boolean the way dbcore binds it: 1 / 0 in Oracle", () => {
    expect(literal(true, "bool", "postgres")).toBe("true");
    expect(literal(false, "tinyint(1)", "mysql")).toBe("false");
    expect(literal(true, "NUMBER(1)", "oracle")).toBe("1");
    expect(literal(false, "NUMBER(1)", "oracle")).toBe("0");
    expect(literal("TRUE", "bool", "oracle")).toBe("1");
    expect(literal("FALSE", "bool", "postgres")).toBe("false");
  });

  it("writes binary as the dialect reads it", () => {
    const bin = { $bin: "00ff" };
    expect(literal(bin, "bytea", "postgres")).toBe("'\\x00ff'");
    expect(literal(bin, "blob", "mysql")).toBe("X'00ff'");
    expect(literal(bin, "blob", "sqlite")).toBe("X'00ff'");
    expect(literal(bin, "BLOB", "oracle")).toBe("hextoraw('00ff')");
    // never anything but hex inside the quotes
    expect(literal({ $bin: "00'; drop table t; --" }, "blob", "mysql")).toBe("X''");
  });

  it("escapes quotes, newlines and backslashes", () => {
    expect(quoteString("postgres", "it's\nnew\\line")).toBe("E'it''s\nnew\\\\line'");
    expect(quoteString("postgres", "plain 'x'")).toBe("'plain ''x'''");
    expect(quoteString("mysql", "a\\b'c")).toBe("'a\\\\b''c'");
    expect(quoteString("sqlite", "a\\b'c")).toBe("'a\\b''c'");
    expect(quoteString("oracle", "a\\b'c")).toBe("'a\\b''c'");
  });
});

describe("statements", () => {
  it("lists the columns in the order of the table and the key in the order of the table", () => {
    const cols = [col("id", "int4", true), col("name", "text"), col("age", "int4")];
    const out = changeStatements("postgres", ref("t"), cols, [
      insert({ age: 3, name: "x", id: 1 }),
      { kind: "update", row: 0, key: { id: 1 }, values: { age: 2, name: "y" } },
    ]);
    expect(out).toEqual([`UPDATE shop.t\nSET name = 'y',\n    age = 2\nWHERE id = 1;`, `INSERT INTO shop.t (id, name, age)\nVALUES (1, 'x', 3);`]);
  });

  it("addresses a row of a table without a key by every column, NULL as is null", () => {
    const cols = [col("a", "int4"), col("b", "text"), col("c", "text")];
    const [stmt] = changeStatements("postgres", ref("t"), cols, [{ kind: "delete", row: 0, key: { c: "x'y", a: 1, b: null }, values: {} }]);
    expect(stmt).toBe(`DELETE\nFROM shop.t\nWHERE a = 1 AND b is null AND c = 'x''y';`);
  });

  it("an empty string is NULL in Oracle: the key says is null", () => {
    const cols = [col("A", "NUMBER"), col("B", "VARCHAR2(10)")];
    const [stmt] = changeStatements("oracle", ref("T", "DEMO"), cols, [{ kind: "delete", row: 0, key: { A: 1, B: "" }, values: {} }]);
    expect(stmt).toBe("DELETE\nFROM DEMO.T\nWHERE A = 1 AND B is null;");
  });

  it("an insert without values is written for each dialect", () => {
    const cols = [col("ID", "NUMBER", true), col("N", "NUMBER")];
    const stmts = (d: Driver) => changeStatements(d, ref(d === "oracle" ? "T" : "t", d === "oracle" ? "DEMO" : "shop"), cols, [insert({})])[0];
    expect(stmts("postgres")).toBe("INSERT INTO shop.t\nDEFAULT VALUES;");
    expect(stmts("sqlite")).toBe("INSERT INTO shop.t\nDEFAULT VALUES;");
    expect(stmts("mysql")).toBe("INSERT INTO shop.t ()\nVALUES ();");
    expect(stmts("oracle")).toBe("INSERT INTO DEMO.T (ID)\nVALUES (DEFAULT);");
  });

  it("SQLite has no DEFAULT keyword in VALUES: the column is left out, as dbcore does", () => {
    const cols = [col("a", "int"), col("b", "text")];
    const [stmt] = changeStatements("sqlite", ref("t", "main"), cols, [insert({ a: DEFAULT_VALUE, b: "x" })]);
    expect(stmt).toBe("INSERT INTO main.t (b)\nVALUES ('x');");
    const [only] = changeStatements("sqlite", ref("t", "main"), cols, [insert({ a: DEFAULT_VALUE })]);
    expect(only).toBe("INSERT INTO main.t\nDEFAULT VALUES;");
    // the other dialects write it
    expect(changeStatements("postgres", ref("t"), cols, [insert({ a: DEFAULT_VALUE, b: "x" })])[0]).toBe("INSERT INTO shop.t (a, b)\nVALUES (DEFAULT, 'x');");
  });
});

describe("UPDATE set to DEFAULT", () => {
  const withDefault = (c: ColumnMeta, def: string | null): ColumnMeta => ({ ...c, default: def });
  const update = (values: GridChange["values"]): GridChange => ({ kind: "update", row: 0, key: { id: 1 }, values });
  const run = (driver: Driver, cols: ColumnMeta[], values: GridChange["values"]) => changeStatements(driver, ref("t", "main"), cols, [update(values)])[0];

  it("SQLite has no DEFAULT keyword: writes the column's default expression, as dbcore does", () => {
    const cols = [col("id", "int", true), withDefault(col("a", "int"), "5"), withDefault(col("b", "text"), " lower('X') ")];
    expect(run("sqlite", cols, { a: DEFAULT_VALUE })).toBe("UPDATE main.t\nSET a = (5)\nWHERE id = 1;");
    expect(run("sqlite", cols, { b: DEFAULT_VALUE })).toBe("UPDATE main.t\nSET b = (lower('X'))\nWHERE id = 1;");
  });

  it("SQLite without a default (or with a blank one) writes null", () => {
    const cols = [col("id", "int", true), col("a", "int"), withDefault(col("b", "int"), null), withDefault(col("c", "int"), "  ")];
    expect(run("sqlite", cols, { a: DEFAULT_VALUE, b: DEFAULT_VALUE, c: DEFAULT_VALUE })).toBe("UPDATE main.t\nSET a = null,\n    b = null,\n    c = null\nWHERE id = 1;");
  });

  it("the other dialects keep the DEFAULT keyword whatever the column default is", () => {
    const cols = [col("id", "int", true), withDefault(col("a", "int"), "5")];
    for (const d of ["postgres", "mysql", "oracle"] as const) expect(run(d, cols, { a: DEFAULT_VALUE })).toMatch(/\nSET \S*a\S* = DEFAULT\n/);
  });

  it("wraps a SQL expression in parentheses, like dbcore", () => {
    const cols = [col("id", "int", true), col("at", "timestamp")];
    expect(run("postgres", cols, { at: { $expr: " now() " } })).toBe("UPDATE main.t\nSET at = (now())\nWHERE id = 1;");
    expect(changeStatements("postgres", ref("t"), cols, [insert({ at: { $expr: "now()" } })])[0]).toBe("INSERT INTO shop.t (at)\nVALUES ((now()));");
  });
});

describe("column order", () => {
  it("puts a column the table does not have last, in the SET list and in the WHERE, as dbcore does", () => {
    const cols = [col("id", "int", true), col("name", "text")];
    const [stmt] = changeStatements("postgres", ref("t"), cols, [
      { kind: "update", row: 0, key: { zz: 1, name: "n", id: 2 }, values: { zz: 1, name: "y" } },
    ]);
    expect(stmt).toBe("UPDATE shop.t\nSET name = 'y',\n    zz = 1\nWHERE id = 2 AND name = 'n' AND zz = 1;");
    const [del] = changeStatements("postgres", ref("t"), cols, [{ kind: "delete", row: 0, key: { zz: 1, id: 2 }, values: {} }]);
    expect(del).toBe("DELETE\nFROM shop.t\nWHERE id = 2 AND zz = 1;");
  });

  it("orders the columns that are not in the table by name (dbcore keeps its maps sorted)", () => {
    const [stmt] = changeStatements("postgres", ref("t"), [col("id", "int", true)], [{ kind: "update", row: 0, key: { id: 1 }, values: { y: 1, x: 2 } }]);
    expect(stmt).toBe("UPDATE shop.t\nSET x = 2,\n    y = 1\nWHERE id = 1;");
  });
});
