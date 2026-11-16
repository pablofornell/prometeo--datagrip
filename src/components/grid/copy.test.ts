import { describe, expect, it } from "vitest";
import type { Driver } from "../../api/types";
import { formatRows, formatSqlInsert } from "./copy";
import type { Cell } from "./types";

const DIALECTS: Driver[] = ["postgres", "mysql", "sqlite", "oracle"];

/** The statement as the dialect writes it: Oracle names are upper case (lower case ones need quotes there). */
const stmt = (d: Driver, table: string, names: string, values: string): string =>
  d === "oracle" ? `insert into ${table.toUpperCase()} (${names.toUpperCase()}) values (${values});\n` : `insert into ${table} (${names}) values (${values});\n`;

const cols = [
  { name: "id", typeName: "int4" },
  { name: "order", typeName: "text" },
  { name: "Note x", typeName: "text" },
];

describe("formatSqlInsert", () => {
  it("one lower case statement per row, each ended by ; and a newline", () => {
    const out = formatSqlInsert(cols.slice(0, 1), [[1], [2]], { tableName: "t" });
    expect(out).toBe("insert into t (id) values (1);\ninsert into t (id) values (2);\n");
  });

  it("an empty selection gives an empty text", () => {
    expect(formatSqlInsert(cols, [], { tableName: "t", dialect: "mysql" })).toBe("");
  });

  it("quotes reserved words and odd names with the identifier quote of the dialect", () => {
    const rows: Cell[][] = [[1, "a", "b"]];
    expect(formatSqlInsert(cols, rows, { tableName: "public.t", dialect: "postgres" })).toBe(
      'insert into public.t (id, "order", "Note x") values (1, \'a\', \'b\');\n',
    );
    expect(formatSqlInsert(cols, rows, { tableName: "shop.t", dialect: "mysql" })).toBe(
      "insert into shop.t (id, `order`, `Note x`) values (1, 'a', 'b');\n",
    );
    expect(formatSqlInsert(cols, rows, { tableName: "main.t", dialect: "sqlite" })).toBe(
      'insert into main.t (id, "order", "Note x") values (1, \'a\', \'b\');\n',
    );
    // Oracle folds unquoted names up: a lower case name is quoted, an upper case one is not
    expect(
      formatSqlInsert(
        [
          { name: "ID", typeName: "NUMBER" },
          { name: "name", typeName: "VARCHAR2" },
        ],
        [[1, "a"]],
        { tableName: "HR.EMP", dialect: "oracle" },
      ),
    ).toBe('insert into HR.EMP (ID, "name") values (1, \'a\');\n');
  });

  it("a table name that comes quoted is not quoted twice", () => {
    const one = [[1]] as Cell[][];
    const c = cols.slice(0, 1);
    expect(formatSqlInsert(c, one, { tableName: '"my table"', dialect: "postgres" })).toBe('insert into "my table" (id) values (1);\n');
    expect(formatSqlInsert(c, one, { tableName: 'public."order"', dialect: "postgres" })).toBe('insert into public."order" (id) values (1);\n');
    expect(formatSqlInsert(c, one, { tableName: "`shop`.`order`", dialect: "mysql" })).toBe("insert into shop.`order` (id) values (1);\n");
    // a raw name with a space (result tab) is quoted
    expect(formatSqlInsert(c, one, { tableName: "public.my table", dialect: "postgres" })).toBe('insert into public."my table" (id) values (1);\n');
    expect(formatSqlInsert(c, one, { tableName: '"a""b"', dialect: "postgres" })).toBe('insert into "a""b" (id) values (1);\n');
  });

  it("falls back to table_name", () => {
    expect(formatSqlInsert(cols.slice(0, 1), [[1]])).toBe("insert into table_name (id) values (1);\n");
  });


  /** `insert into t (v) values (<v>)` of one cell; the names are upper case for Oracle (see `stmt`). */
  const one = (d: Driver, typeName: string, v: Cell): string => {
    const name = d === "oracle" ? "V" : "v";
    return formatSqlInsert([{ name, typeName }], [[v]], { tableName: d === "oracle" ? "T" : "t", dialect: d });
  };

  describe("string literals", () => {
    it("doubles single quotes everywhere", () => {
      for (const d of DIALECTS) expect(one(d, "text", "it's")).toBe(stmt(d, "t", "v", "'it''s'"));
    });

    it("MySQL escapes the backslash, PostgreSQL writes E'..', SQLite and Oracle take it literally", () => {
      expect(one("mysql", "text", "C:\\temp")).toBe("insert into t (v) values ('C:\\\\temp');\n");
      expect(one("postgres", "text", "C:\\temp")).toBe("insert into t (v) values (E'C:\\\\temp');\n");
      expect(one("sqlite", "text", "C:\\temp")).toBe("insert into t (v) values ('C:\\temp');\n");
      expect(one("oracle", "text", "C:\\temp")).toBe("insert into T (V) values ('C:\\temp');\n");
    });
  });

  describe("booleans", () => {
    it("true / false, and 1 / 0 for Oracle", () => {
      expect(one("postgres", "boolean", true)).toBe("insert into t (v) values (true);\n");
      expect(one("mysql", "boolean", false)).toBe("insert into t (v) values (false);\n");
      expect(one("sqlite", "boolean", true)).toBe("insert into t (v) values (true);\n");
      expect(one("oracle", "boolean", true)).toBe("insert into T (V) values (1);\n");
      expect(one("oracle", "boolean", false)).toBe("insert into T (V) values (0);\n");
      expect(one("oracle", "boolean", "true")).toBe("insert into T (V) values (1);\n");
    });
  });

  describe("binary", () => {
    const bin: Cell = { $bin: "00ff", len: 2 };

    it("PostgreSQL bytea hex, MySQL / SQLite X'..', Oracle hextoraw", () => {
      expect(one("postgres", "bytea", bin)).toBe("insert into t (v) values ('\\x00ff'::bytea);\n");
      expect(one("mysql", "blob", bin)).toBe("insert into t (v) values (X'00ff');\n");
      expect(one("sqlite", "blob", bin)).toBe("insert into t (v) values (X'00ff');\n");
      expect(one("oracle", "raw", bin)).toBe("insert into T (V) values (hextoraw('00ff'));\n");
    });
  });

  describe("null, numbers, dates", () => {
    it("null is lower case; numeric text stays unquoted in a numeric column", () => {
      for (const d of DIALECTS) {
        expect(one(d, "numeric", "12.50")).toBe(stmt(d, "t", "v", "12.50"));
        expect(one(d, "text", null)).toBe(stmt(d, "t", "v", "null"));
      }
    });

    it("Oracle writes DATE and TIMESTAMP as ANSI literals", () => {
      expect(one("oracle", "DATE", "2024-01-02")).toBe("insert into T (V) values (date '2024-01-02');\n");
      expect(one("oracle", "TIMESTAMP(6)", "2024-01-02 03:04:05")).toBe("insert into T (V) values (timestamp '2024-01-02 03:04:05');\n");
      expect(one("postgres", "timestamp", "2024-01-02 03:04:05")).toBe("insert into t (v) values ('2024-01-02 03:04:05');\n");
    });

    it("an object (json) is a quoted JSON text, escaped for the dialect", () => {
      const v = { s: "it's \\" } as unknown as Cell;
      expect(one("postgres", "jsonb", v)).toBe("insert into t (v) values (E'{\"s\":\"it''s \\\\\\\\\"}');\n");
      expect(one("mysql", "json", v)).toBe("insert into t (v) values ('{\"s\":\"it''s \\\\\\\\\"}');\n");
    });
  });

  describe("default cells", () => {
    const c = [
      { name: "id", typeName: "int4" },
      { name: "n", typeName: "text" },
    ];
    const def: Cell = { $default: true };
    const row = [def, "x"] as Cell[];

    it("default stays a keyword (lower case) where VALUES takes it", () => {
      expect(formatSqlInsert(c, [row], { tableName: "t", dialect: "postgres" })).toBe("insert into t (id, n) values (default, 'x');\n");
      expect(formatSqlInsert(c, [row], { tableName: "t", dialect: "mysql" })).toBe("insert into t (id, n) values (default, 'x');\n");
      const ora = [
        { name: "ID", typeName: "NUMBER" },
        { name: "N", typeName: "VARCHAR2" },
      ];
      expect(formatSqlInsert(ora, [row], { tableName: "T", dialect: "oracle" })).toBe("insert into T (ID, N) values (default, 'x');\n");
    });

    it("SQLite leaves the column out", () => {
      expect(formatSqlInsert(c, [row], { tableName: "t", dialect: "sqlite" })).toBe("insert into t (n) values ('x');\n");
    });

    it("a row of defaults only", () => {
      const all = [[def, def]] as Cell[][];
      expect(formatSqlInsert(c, all, { tableName: "t", dialect: "postgres" })).toBe("insert into t (id, n) values (default, default);\n");
      expect(formatSqlInsert(c, all, { tableName: "t", dialect: "sqlite" })).toBe("insert into t default values;\n");
      expect(formatSqlInsert([c[0]], [[def]], { tableName: "t", dialect: "mysql" })).toBe("insert into t (id) values (default);\n");
    });
  });
});

describe("formatRows sql", () => {
  it("passes the dialect on", () => {
    expect(formatRows("sql", [{ name: "order", typeName: "int" }], [[1]], { tableName: "t", dialect: "mysql" })).toBe("insert into t (`order`) values (1);\n");
  });
});
