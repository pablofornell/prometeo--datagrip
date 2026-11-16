// @vitest-environment node
/** Quoting, literals and layout of the generated DDL: names that need quotes, index expressions, paragraphs. */
import { describe, expect, it } from "vitest";
import { type TableDef, cloneTable, emptyTable, newCheck, newColumn, newFk, newIndex, newKey } from "./model";
import { alterTablePlan, createTablePlan, literal, planText } from "./sqlgen";

type D = "postgres" | "mysql" | "sqlite" | "oracle";

/** A table whose names all need quotes somewhere. */
function odd(d: D): TableDef {
  const ora = d === "oracle";
  const t = emptyTable(d === "sqlite" ? "main" : ora ? "DEMO" : "shop", ora ? "ORDER_ITEMS" : "Order Items");
  t.columns = [
    newColumn({ name: "id", type: ora ? "NUMBER(10)" : "integer", notNull: true }),
    newColumn({ name: "order id", type: ora ? "NUMBER(10)" : "integer", notNull: true }),
    newColumn({ name: "select", type: ora ? "VARCHAR2(50 CHAR)" : "varchar(50)" }),
    newColumn({ name: "Created", type: ora ? "TIMESTAMP" : "timestamp" }),
  ];
  t.keys = [newKey({ name: "pk_oi", primary: true, columns: ["id", "order id"] }), newKey({ columns: ["select", "Created"] })];
  t.fks = [newFk({ name: "fk x", columns: ["id", "order id"], refSchema: t.schema, refTable: "Other Table", refColumns: ["a", "b c"], onDelete: "CASCADE" })];
  t.indexes = [newIndex({ name: "idx 1", unique: true, columns: ["order id", "Created"] })];
  return t;
}

const text = (d: D, t: TableDef) => planText(createTablePlan(d, t));

describe("names with spaces or keywords in keys, foreign keys and indexes", () => {
  it("postgres", () => {
    const sql = text("postgres", odd("postgres"));
    expect(sql).toContain('constraint pk_oi primary key (id, "order id"),');
    expect(sql).toContain('unique ("select", "Created"),');
    expect(sql).toContain('constraint "fk x" foreign key (id, "order id") references shop."Other Table" (a, "b c") on delete cascade');
    expect(sql).toContain('create unique index "idx 1" on shop."Order Items" ("order id", "Created");');
  });

  it("mysql", () => {
    const sql = text("mysql", odd("mysql"));
    expect(sql).toContain("    primary key (id, `order id`),");
    expect(sql).toContain("    unique (`select`, Created),");
    expect(sql).toContain("references shop.`Other Table` (a, `b c`) on delete cascade");
    expect(sql).toContain("create unique index `idx 1` on shop.`Order Items` (`order id`, Created);");
  });

  it("sqlite", () => {
    const sql = text("sqlite", odd("sqlite"));
    expect(sql).toContain('constraint pk_oi primary key (id, "order id"),');
    expect(sql).toContain('references "Other Table" (a, "b c") on delete cascade');
    expect(sql).toContain('create unique index "idx 1" on "Order Items" ("order id", Created);');
  });

  it("oracle: lower-case names are quoted, upper-case ones are not", () => {
    const sql = text("oracle", odd("oracle"));
    expect(sql).toContain('constraint "pk_oi" primary key ("id", "order id"),');
    expect(sql).toContain('references DEMO."Other Table" ("a", "b c") on delete cascade');
    expect(sql).toContain('create unique index DEMO."idx 1" on DEMO.ORDER_ITEMS ("order id", "Created");');
  });

  it("an injected quote stays inside the identifier", () => {
    const t = odd("postgres");
    t.keys = [newKey({ primary: true, columns: ['a"b; drop table t; --'] })];
    expect(text("postgres", t)).toContain('primary key ("a""b; drop table t; --")');
    const m = odd("mysql");
    m.keys = [newKey({ primary: true, columns: ["a`b; drop table t; --"] })];
    expect(text("mysql", m)).toContain("primary key (`a``b; drop table t; --`)");
  });
});

describe("index entries", () => {
  const idx = (d: D, columns: string[], cols = ["a", "b"]) => {
    const t = emptyTable(d === "oracle" ? "DEMO" : "shop", d === "oracle" ? "T" : "t");
    t.columns = cols.map((n) => newColumn({ name: n, type: "integer" }));
    t.indexes = [newIndex({ name: d === "oracle" ? "IX" : "ix", columns })];
    return createTablePlan(d, t).statements[1];
  };

  it("an expression is written the way the dialect wants it", () => {
    // PostgreSQL: a function call as it is, any other expression in parentheses
    expect(idx("postgres", ["lower(a)"])).toBe("create index ix on shop.t (lower(a));");
    expect(idx("postgres", ["a + b"])).toBe("create index ix on shop.t ((a + b));");
    expect(idx("postgres", ["(a + b)"])).toBe("create index ix on shop.t ((a + b));");
    // MySQL: a functional key part is always in parentheses; a prefix length stays a prefix length
    expect(idx("mysql", ["lower(a)"])).toBe("create index ix on shop.t ((lower(a)));");
    expect(idx("mysql", ["a(10)", "b"])).toBe("create index ix on shop.t (a(10), b);");
    // SQLite and Oracle take the expression as typed
    expect(idx("sqlite", ["lower(a)"])).toBe("create index ix on shop.t (lower(a));");
    expect(idx("oracle", ["UPPER(a)"])).toBe("create index DEMO.IX on DEMO.T (UPPER(a));");
  });

  it("keeps asc / desc and quotes the column in front of it", () => {
    expect(idx("postgres", ["a desc", "b ASC"])).toBe("create index ix on shop.t (a desc, b asc);");
    expect(idx("mysql", ["order id desc"], ["order id"])).toBe("create index ix on shop.t (`order id` desc);");
  });

  it("a column of the table is a column whatever its name looks like", () => {
    expect(idx("postgres", ["lower(x)"], ["lower(x)"])).toBe('create index ix on shop.t ("lower(x)");');
  });
});

describe("paragraphs", () => {
  it("the statements of a plan are one paragraph each, as DataGrip's preview shows them", () => {
    const t = odd("postgres");
    t.comment = "orders";
    const sql = text("postgres", t);
    expect(sql).toContain(");\n\ncreate unique index");
    expect(sql).toContain('("order id", "Created");\n\ncomment on table');
    expect(sql.endsWith("is 'orders';")).toBe(true);
  });

  it("an alter plan separates its statements too", () => {
    const base = odd("postgres");
    const cur = cloneTable(base);
    cur.columns.push(newColumn({ name: "note", type: "text" }));
    cur.comment = "x";
    expect(planText(alterTablePlan("postgres", base, cur))).toBe(
      ['alter table shop."Order Items" add column note text;', 'comment on table shop."Order Items" is \'x\';'].join("\n\n"),
    );
  });
});

describe("literals", () => {
  it("escapes quotes in every dialect and backslashes where they mean something", () => {
    expect(literal("postgres", "it's")).toBe("'it''s'");
    expect(literal("postgres", "a\\b")).toBe("E'a\\\\b'");
    expect(literal("postgres", "it's a\\b\nc")).toBe("E'it''s a\\\\b\nc'");
    expect(literal("mysql", "a\\b'c")).toBe("'a\\\\b''c'");
    expect(literal("sqlite", "a\\b'c")).toBe("'a\\b''c'");
    expect(literal("oracle", "a\\b'c")).toBe("'a\\b''c'");
  });

  it("a comment with a quote cannot end its literal", () => {
    const t = odd("postgres");
    t.comment = "x'; drop table t; --";
    expect(text("postgres", t)).toContain("comment on table shop.\"Order Items\" is 'x''; drop table t; --';");
    t.comment = "x\\'; drop table t; --";
    expect(text("postgres", t)).toContain("is E'x\\\\''; drop table t; --';");
  });
});

describe("postgres type change", () => {
  it("converts the values with using, so text -> integer runs", () => {
    const base = emptyTable("shop", "t");
    base.columns = [newColumn({ name: "n", type: "text" }), newColumn({ name: "Big Col", type: "varchar(5)" })];
    const cur = cloneTable(base);
    cur.columns[0].type = "integer";
    cur.columns[1].type = "numeric(10,2)";
    expect(alterTablePlan("postgres", base, cur).statements).toEqual([
      "alter table shop.t alter column n type integer using n::integer;",
      'alter table shop.t alter column "Big Col" type numeric(10,2) using "Big Col"::numeric(10,2);',
    ]);
  });
});

describe("checks and defaults stay as typed", () => {
  it("writes the expression the user gave, in parentheses", () => {
    const t = emptyTable("shop", "t");
    t.columns = [newColumn({ name: "a", type: "integer", default: "(1 + 2)" })];
    t.checks = [newCheck({ name: "ck", expr: "  a > 0  " })];
    expect(text("postgres", t)).toBe("create table shop.t\n(\n    a integer default (1 + 2),\n    constraint ck check (a > 0)\n);");
  });
});
