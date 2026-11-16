import { describe, expect, it } from "vitest";
import type { CompareColumn, CompareCheck, CompareForeignKey, CompareIndex, CompareKey, CompareTable, CompareView, Driver, SchemaModel } from "../../api/types";
import { PHASE, planCounts, planMigration, renderMigration, stripForeignKeys, tableDdlKey, tablesToCreate, type MigrationPlan } from "./migration";

const col = (name: string, dataType: string, p: Partial<CompareColumn> = {}): CompareColumn => ({
  name,
  position: 1,
  dataType,
  nullable: true,
  default: null,
  extra: null,
  ...p,
});

const table = (name: string, p: Partial<CompareTable> = {}): CompareTable => ({
  name,
  columns: [],
  primaryKey: null,
  unique: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
  ...p,
});

const model = (driver: Driver, schema: string, p: Partial<SchemaModel> = {}): SchemaModel => ({
  driver,
  schema,
  namePrefix: null,
  tables: [],
  views: [],
  sequences: [],
  routines: [],
  ...p,
});

const key = (name: string, columns: string[]): CompareKey => ({ name, columns });
const index = (name: string, p: Partial<CompareIndex> = {}): CompareIndex => ({ name, columns: ["NAME"], unique: false, method: "", predicate: null, ...p });
const fk = (name: string, p: Partial<CompareForeignKey> = {}): CompareForeignKey => ({
  name,
  columns: ["DEPT_ID"],
  refSchema: null,
  refTable: "DEPT",
  refColumns: ["ID"],
  onDelete: "NO ACTION",
  ...p,
});
const view = (name: string, definition: string): CompareView => ({ name, definition, materialized: false });

/** The SQL of the statements of a phase, in the plan's order. */
const sqlOf = (plan: MigrationPlan, phase?: number) =>
  plan.statements.filter((s) => phase === undefined || s.phase === phase).map((s) => s.sql);

describe("planMigration: Oracle", () => {
  const a = model("oracle", "A", {
    tables: [
      table("EMP", {
        columns: [
          col("ID", "NUMBER(10)", { nullable: false }),
          col("NAME", "VARCHAR2(80)"),
          col("HIRED", "DATE", { default: "SYSDATE" }),
        ],
        primaryKey: key("PK_EMP", ["ID"]),
        indexes: [index("IX_EMP_NAME")],
        foreignKeys: [fk("FK_EMP_DEPT", { onDelete: "CASCADE" })],
      }),
      table("DEPT", { columns: [col("ID", "NUMBER(10)", { nullable: false })], primaryKey: key("PK_DEPT", ["ID"]) }),
    ],
    views: [view("V_EMP", "select id, name from emp")],
    sequences: [{ name: "S_ID", incrementBy: "1", minValue: "1", maxValue: "99999", cycle: false, cacheSize: "20" }],
  });
  const b = model("oracle", "B", {
    tables: [
      table("EMP", {
        columns: [
          col("ID", "NUMBER(10)", { nullable: false }),
          col("NAME", "VARCHAR2(50)", { nullable: false }),
          col("OLD_COL", "VARCHAR2(5)"),
        ],
        primaryKey: key("PK_EMP", ["ID"]),
        indexes: [index("IX_EMP_NAME", { unique: true })],
      }),
      table("LEGACY", { columns: [col("ID", "NUMBER(10)")] }),
    ],
    views: [view("V_EMP", "select id from emp")],
    sequences: [{ name: "S_ID", incrementBy: "5", minValue: "1", maxValue: "99999", cycle: false, cacheSize: "0" }],
  });
  const ddl = new Map([[tableDdlKey("DEPT"), 'CREATE TABLE "DEPT" ("ID" NUMBER(10) NOT NULL, CONSTRAINT "PK_DEPT" PRIMARY KEY ("ID"))']]);
  const plan = planMigration(a, b, undefined, ddl);

  it("sets the current schema of B first", () => {
    expect(plan.header).toEqual(['alter session set current_schema = "B";']);
  });

  it("creates the table that exists only in A from its DDL, first", () => {
    expect(sqlOf(plan, 0)).toEqual(['CREATE TABLE "DEPT" ("ID" NUMBER(10) NOT NULL, CONSTRAINT "PK_DEPT" PRIMARY KEY ("ID"));']);
  });

  it("drops the changed index, then creates it again", () => {
    expect(sqlOf(plan, 1)).toContain('drop index "IX_EMP_NAME";');
    expect(sqlOf(plan, 5)).toEqual(['create index "IX_EMP_NAME" on "EMP" ("NAME");']);
  });

  it("modifies the changed column with the attributes of A that differ, and adds the new one", () => {
    expect(sqlOf(plan, 2)).toEqual([
      'alter table "EMP" modify ("NAME" VARCHAR2(80) null);',
      'alter table "EMP" add ("HIRED" DATE default SYSDATE);',
    ]);
  });

  it("adds the foreign key of A with its delete rule, after the keys", () => {
    expect(sqlOf(plan, 4)).toEqual(['alter table "EMP" add constraint "FK_EMP_DEPT" foreign key ("DEPT_ID") references "DEPT" ("ID") on delete cascade;']);
  });

  it("writes the view of A with CREATE OR REPLACE and the sequence with ALTER SEQUENCE", () => {
    expect(sqlOf(plan, 6)).toEqual(['create or replace view "V_EMP" as select id, name from emp;']);
    expect(sqlOf(plan, 7)).toEqual(['alter sequence "S_ID" increment by 1 minvalue 1 maxvalue 99999 nocycle cache 20;']);
  });

  it("marks the drops of objects that exist only in B as destructive", () => {
    const drops = plan.statements.filter((s) => s.phase === 8);
    expect(drops.map((s) => [s.sql, s.destructive])).toEqual([
      ['alter table "EMP" drop column "OLD_COL";', true],
      ['drop table "LEGACY" cascade constraints;', true],
    ]);
  });

  it("comments the destructive statements out unless drops are included", () => {
    const text = renderMigration(plan, { includeDrops: false }, { from: "A", to: "B" });
    expect(text).toContain('-- alter table "EMP" drop column "OLD_COL";');
    expect(text).toContain('-- drop table "LEGACY" cascade constraints;');
    expect(text).toContain('\nalter session set current_schema = "B";\n');
    expect(text).toContain('\ndrop index "IX_EMP_NAME";\n');
    expect(text).toContain("-- Migration: make B like A (Oracle)");
    const all = renderMigration(plan, { includeDrops: true }, { from: "A", to: "B" });
    expect(all).toContain('\nalter table "EMP" drop column "OLD_COL";\n');
    expect(all).not.toContain('-- alter table "EMP" drop column "OLD_COL";');
  });

  it("counts the statements that run for the options", () => {
    expect(planCounts(plan, { includeDrops: false }).commented).toBe(2);
    expect(planCounts(plan, { includeDrops: true })).toEqual({ total: plan.statements.length, active: plan.statements.length, commented: 0 });
  });

  it("lists the tables that exist only in A", () => {
    expect(tablesToCreate(a, b)).toEqual(["DEPT"]);
  });

  it("notes a table of A whose DDL was not given", () => {
    const missing = planMigration(a, b, undefined, new Map());
    expect(missing.notes).toContain("table DEPT: the DDL of A is missing; create the table by hand");
  });
});

describe("planMigration: PostgreSQL", () => {
  const a = model("postgres", "shop_a", {
    tables: [
      table("orders", {
        columns: [col("id", "integer", { nullable: false }), col("total", "numeric(10,2)", { nullable: false, default: "0" }), col("status", "varchar(10)")],
        primaryKey: key("orders_pkey", ["id"]),
        checks: [{ name: "ck_total", expression: "(total >= 0)" } as CompareCheck],
        indexes: [index("orders_status_idx", { columns: ["status"], method: "btree" })],
      }),
    ],
  });
  const b = model("postgres", "shop_b", {
    tables: [
      table("orders", {
        columns: [col("id", "integer", { nullable: false }), col("total", "numeric(10,2)")],
        primaryKey: key("orders_pkey", ["id"]),
        unique: [key("orders_code_key", ["total"])],
      }),
      table("old"),
    ],
  });
  const plan = planMigration(a, b);

  it("sets the search path to B", () => {
    expect(plan.header).toEqual(['set search_path to "shop_b";']);
  });

  it("alters each attribute of the column separately, and adds the new column", () => {
    expect(sqlOf(plan, 2)).toEqual([
      'alter table "orders" alter column "total" set not null;',
      'alter table "orders" alter column "total" set default 0;',
      'alter table "orders" add column "status" varchar(10);',
    ]);
  });

  it("adds the check, creates the index without USING for btree", () => {
    expect(sqlOf(plan, 3)).toEqual(['alter table "orders" add constraint "ck_total" check ((total >= 0));']);
    expect(sqlOf(plan, 5)).toEqual(['create index "orders_status_idx" on "orders" ("status");']);
  });

  it("drops the unique constraint that only B has (commented out) and the table only in B", () => {
    const drops = plan.statements.filter((s) => s.phase === 1 || s.phase === 8);
    expect(drops.map((s) => [s.sql, s.destructive])).toEqual([
      ['alter table "orders" drop constraint "orders_code_key";', true],
      ['drop table "old";', true],
    ]);
  });
});

describe("planMigration: MySQL", () => {
  const a = model("mysql", "shop_a", {
    tables: [
      table("items", {
        columns: [col("id", "int", { nullable: false }), col("price", "decimal(10,2)", { nullable: false, default: "0" })],
        foreignKeys: [fk("fk_items_order", { columns: ["order_id"], refTable: "orders", refColumns: ["id"], onDelete: "CASCADE" })],
        indexes: [index("ix_price", { columns: ["price"], method: "btree" })],
      }),
    ],
  });
  const b = model("mysql", "shop_b", {
    tables: [
      table("items", {
        columns: [col("id", "int", { nullable: false }), col("price", "decimal(8,2)")],
        foreignKeys: [fk("fk_items_order", { columns: ["order_id"], refTable: "orders", refColumns: ["id"] })],
        indexes: [index("ix_price", { columns: ["price"], method: "btree", unique: true })],
      }),
    ],
  });
  const plan = planMigration(a, b);

  it("uses USE and MODIFY COLUMN with the full definition", () => {
    expect(plan.header).toEqual(["use `shop_b`;"]);
    expect(sqlOf(plan, 2)).toEqual(["alter table `items` modify column `price` decimal(10,2) default 0 not null;"]);
  });

  it("drops a foreign key and its index with the MySQL statements", () => {
    expect(sqlOf(plan, 1)).toEqual(["alter table `items` drop foreign key `fk_items_order`;", "drop index `ix_price` on `items`;"]);
    expect(sqlOf(plan, 4)).toEqual(["alter table `items` add constraint `fk_items_order` foreign key (`order_id`) references `orders` (`id`) on delete cascade;"]);
    expect(sqlOf(plan, 5)).toEqual(["create index `ix_price` on `items` (`price`);"]);
  });
});

describe("planMigration: SQLite", () => {
  const a = model("sqlite", "main", {
    tables: [
      table("t", {
        columns: [col("id", "integer", { nullable: false }), col("name", "text", { nullable: false }), col("extra", "text")],
        primaryKey: { name: "", columns: ["id"] },
      }),
    ],
    views: [view("v", "select id from t")],
  });
  const b = model("sqlite", "main", {
    tables: [table("t", { columns: [col("id", "integer", { nullable: false }), col("name", "text")], primaryKey: { name: "", columns: ["id"] } })],
    views: [view("v", "select id, name from t")],
  });
  const plan = planMigration(a, b);

  it("adds the column in place and notes the change of a column for a rebuild", () => {
    expect(plan.header).toEqual([]);
    expect(sqlOf(plan, 2)).toEqual(['alter table "t" add column "extra" text;']);
    expect(plan.notes).toContain(
      "table t: change column name: not generated for SQLite (SQLite changes this only by rebuilding the table); write it by hand",
    );
  });

  it("replaces a changed view by a drop and a create", () => {
    expect(sqlOf(plan, 6)).toEqual(['drop view if exists "v";', 'create view "v" as select id from t;']);
    const replaced = plan.statements.filter((s) => s.phase === 6);
    expect(replaced.every((s) => !s.destructive)).toBe(true);
  });
});

describe("planMigration: other cases", () => {
  it("writes no script between two DBMS, but says why", () => {
    const plan = planMigration(model("postgres", "s"), model("oracle", "S"));
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual(["s is on PostgreSQL and S on Oracle: no migration script between two DBMS."]);
  });

  it("writes nothing for identical schemas", () => {
    const m = model("postgres", "s", { tables: [table("t", { columns: [col("id", "integer")] })] });
    const plan = planMigration(m, m);
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(renderMigration(plan, { includeDrops: false }, { from: "s", to: "s" })).not.toContain("-- NOTE");
  });

  it("renders the statements in phase order with their comments", () => {
    const a = model("postgres", "a", { tables: [table("t", { columns: [col("n", "integer")] })] });
    const b = model("postgres", "b", { tables: [table("t", { columns: [col("n", "integer")], unique: [key("u", ["n"])] })] });
    const text = renderMigration(planMigration(a, b), { includeDrops: false }, { from: "a", to: "b" });
    expect(text).toContain('-- Statements that drop objects are commented out: uncomment them to apply them.');
    expect(text).toContain('-- table t: unique u (only in B)');
    expect(text.split("\n")).toContain('-- alter table "t" drop constraint "u";');
  });
});

describe("planMigration: Oracle column attributes", () => {
  /** The column statements that turn column `from` of A into column `to` of B. */
  const alter = (from: CompareColumn, to: CompareColumn): string[] => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [from] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [to] })] });
    return sqlOf(planMigration(a, b), PHASE.columns);
  };

  it("modifies only the type when only the type differs", () => {
    expect(alter(col("C", "VARCHAR2(80)"), col("C", "VARCHAR2(50)"))).toEqual(['alter table "T" modify ("C" VARCHAR2(80));']);
  });

  it("modifies only the default when only the default differs", () => {
    expect(alter(col("C", "NUMBER(5)", { default: "5" }), col("C", "NUMBER(5)"))).toEqual(['alter table "T" modify ("C" default 5);']);
    expect(alter(col("C", "NUMBER(5)"), col("C", "NUMBER(5)", { default: "5" }))).toEqual(['alter table "T" modify ("C" default null);']);
  });

  it("modifies only the nullability when only that differs", () => {
    expect(alter(col("C", "NUMBER(5)", { nullable: false }), col("C", "NUMBER(5)"))).toEqual(['alter table "T" modify ("C" not null);']);
    expect(alter(col("C", "NUMBER(5)"), col("C", "NUMBER(5)", { nullable: false }))).toEqual(['alter table "T" modify ("C" null);']);
  });

  it("writes every attribute that differs in one MODIFY", () => {
    expect(alter(col("C", "VARCHAR2(80)", { default: "'x'", nullable: false }), col("C", "VARCHAR2(50)"))).toEqual([
      `alter table "T" modify ("C" VARCHAR2(80) default 'x' not null);`,
    ]);
  });

  it("compares Oracle defaults without case and white space outside literals, literals as they are", () => {
    expect(alter(col("C", "DATE", { default: "sysdate " }), col("C", "DATE", { default: "SYSDATE" }))).toEqual([]);
    expect(alter(col("C", "VARCHAR2(5)", { default: "'a'" }), col("C", "VARCHAR2(5)", { default: "'A'" }))).toEqual([
      `alter table "T" modify ("C" default 'a');`,
    ]);
  });
});

describe("planMigration: a NOT NULL column added to a table", () => {
  it("adds it nullable on Oracle and writes the NOT NULL as a comment to run after the fill", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("ID", "NUMBER(10)", { nullable: false }), col("CODE", "VARCHAR2(5)", { nullable: false })] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [col("ID", "NUMBER(10)", { nullable: false })] })] });
    expect(sqlOf(planMigration(a, b), PHASE.columns)).toEqual([
      'alter table "T" add ("CODE" VARCHAR2(5));\n-- TODO: fill the column, then:\n-- alter table "T" modify ("CODE" not null);',
    ]);
  });

  it("does the same on PostgreSQL", () => {
    const a = model("postgres", "a", { tables: [table("t", { columns: [col("code", "varchar(5)", { nullable: false })] })] });
    const b = model("postgres", "b", { tables: [table("t")] });
    expect(sqlOf(planMigration(a, b), PHASE.columns)).toEqual([
      'alter table "t" add column "code" varchar(5);\n-- TODO: fill the column, then:\n-- alter table "t" alter column "code" set not null;',
    ]);
  });

  it("keeps the NOT NULL on MySQL, which fills the new column itself, and on a column with a default", () => {
    const a = model("mysql", "a", {
      tables: [table("t", { columns: [col("code", "varchar(5)", { nullable: false }), col("n", "int", { nullable: false, default: "0", defaultKind: "literal" })] })],
    });
    const b = model("mysql", "b", { tables: [table("t")] });
    expect(sqlOf(planMigration(a, b), PHASE.columns)).toEqual([
      "alter table `t` add column `code` varchar(5) not null;",
      "alter table `t` add column `n` int default 0 not null;",
    ]);
  });
});

describe("planMigration: dropped columns on Oracle", () => {
  it("drops a column of a composite key with CASCADE CONSTRAINTS", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("ID", "NUMBER(10)", { nullable: false })] })] });
    const b = model("oracle", "B", {
      tables: [table("T", { columns: [col("ID", "NUMBER(10)", { nullable: false }), col("CODE", "VARCHAR2(5)")], primaryKey: key("T_PK", ["ID", "CODE"]) })],
    });
    expect(sqlOf(planMigration(a, b), PHASE.drops)).toEqual(['alter table "T" drop ("CODE") cascade constraints;']);
  });

  it("drops a plain column with DROP COLUMN", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("ID", "NUMBER(10)")] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [col("ID", "NUMBER(10)"), col("OLD", "VARCHAR2(5)")] })] });
    expect(sqlOf(planMigration(a, b), PHASE.drops)).toEqual(['alter table "T" drop column "OLD";']);
  });

  it("uses CASCADE CONSTRAINTS for a column that a foreign key of B refers to", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("ID", "NUMBER(10)")] }), table("R", { columns: [col("ID", "NUMBER(10)")] })] });
    const b = model("oracle", "B", {
      tables: [
        table("T", { columns: [col("ID", "NUMBER(10)"), col("KEY_COL", "VARCHAR2(5)")] }),
        table("R", {
          columns: [col("ID", "NUMBER(10)"), col("T_KEY", "VARCHAR2(5)")],
          foreignKeys: [fk("R_T_FK", { columns: ["T_KEY"], refTable: "T", refColumns: ["KEY_COL"] })],
        }),
      ],
    });
    const plan = planMigration(a, b);
    expect(sqlOf(plan, PHASE.drops)).toEqual(['alter table "T" drop ("KEY_COL") cascade constraints;', 'alter table "R" drop column "T_KEY";']);
    expect(sqlOf(plan, PHASE.replace)).toEqual(['alter table "R" drop constraint "R_T_FK";']);
  });
});

describe("planMigration: constraints whose name the system made up (Oracle)", () => {
  const sys = (name: string, columns: string[]): CompareKey => ({ name, columns, generatedName: true });

  it("writes nothing for an unnamed key and an unnamed unique that both sides have", () => {
    const t = (pk: string, uq: string) =>
      table("T", {
        columns: [col("ID", "NUMBER(10)", { nullable: false }), col("CODE", "VARCHAR2(5)")],
        primaryKey: sys(pk, ["ID"]),
        unique: [sys(uq, ["CODE"])],
      });
    const plan = planMigration(model("oracle", "A", { tables: [t("SYS_C001", "SYS_C002")] }), model("oracle", "B", { tables: [t("SYS_C101", "SYS_C102")] }));
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it("adds an unnamed unique without a CONSTRAINT clause", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("CODE", "VARCHAR2(5)")], unique: [sys("SYS_C001", ["CODE"])] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [col("CODE", "VARCHAR2(5)")] })] });
    expect(sqlOf(planMigration(a, b), PHASE.keys)).toEqual(['alter table "T" add unique ("CODE");']);
  });

  it("matches a named key with an unnamed one of the same definition", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("ID", "NUMBER(10)")], primaryKey: key("T_PK", ["ID"]) })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [col("ID", "NUMBER(10)")], primaryKey: sys("SYS_C101", ["ID"]) })] });
    expect(planMigration(a, b).statements).toEqual([]);
  });

  it("notes an index whose name the system made up instead of creating it without a name", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("NAME", "VARCHAR2(5)")], indexes: [index("SYS_IDX", { generatedName: true })] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [col("NAME", "VARCHAR2(5)")] })] });
    const plan = planMigration(a, b);
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual(["table T: add index (NAME): not generated for Oracle; write it by hand"]);
  });
});

describe("planMigration: keys that foreign keys refer to", () => {
  const lines = (orders: CompareKey) => [
    table("ORDERS", { columns: [col("ID", "NUMBER(10)", { nullable: false })], primaryKey: orders }),
    table("LINES", {
      columns: [col("ID", "NUMBER(10)", { nullable: false }), col("ORDER_ID", "NUMBER(10)")],
      primaryKey: key("LINES_PK", ["ID"]),
      foreignKeys: [fk("LINES_ORDER_FK", { columns: ["ORDER_ID"], refTable: "ORDERS", refColumns: ["ID"] })],
    }),
  ];
  const a = model("oracle", "A", { tables: lines(key("ORDERS_PK", ["ID"])) });
  const b = model("oracle", "B", { tables: lines(key("ORDERS_PK_OLD", ["ID"])) });
  const plan = planMigration(a, b);

  it("drops the foreign key first, replaces the key, and adds the foreign key again after it", () => {
    const sqls = [...plan.statements].sort((x, y) => x.phase - y.phase).filter((s) => s.phase >= PHASE.replace && s.phase <= PHASE.foreignKeys).map((s) => s.sql);
    expect(sqls).toEqual([
      'alter table "LINES" drop constraint "LINES_ORDER_FK";',
      'alter table "ORDERS" drop primary key;',
      'alter table "ORDERS" add constraint "ORDERS_PK" primary key ("ID");',
      'alter table "LINES" add constraint "LINES_ORDER_FK" foreign key ("ORDER_ID") references "ORDERS" ("ID");',
    ]);
  });

  it("keeps the drop of the renamed key active: it makes room for A's key with the same columns", () => {
    const drop = plan.statements.find((s) => s.sql === 'alter table "ORDERS" drop primary key;');
    expect(drop?.destructive).toBe(false);
    expect(planCounts(plan, { includeDrops: false }).commented).toBe(0);
  });

  it("drops the foreign keys of B that refer to a key being replaced, also from a table only in B", () => {
    const b2 = model("oracle", "B", {
      tables: [
        ...lines(key("ORDERS_PK_OLD", ["ID"])),
        table("AUDIT_OLD", {
          columns: [col("ID", "NUMBER(10)", { nullable: false }), col("ORDER_ID", "NUMBER(10)")],
          foreignKeys: [fk("AUDIT_ORDER_FK", { columns: ["ORDER_ID"], refTable: "ORDERS", refColumns: ["ID"] })],
        }),
      ],
    });
    const plan2 = planMigration(model("oracle", "A", { tables: lines(key("ORDERS_PK", ["ID"])) }), b2);
    expect(sqlOf(plan2, PHASE.replace)).toContain('alter table "AUDIT_OLD" drop constraint "AUDIT_ORDER_FK";');
    expect(sqlOf(plan2, PHASE.drops)).toEqual(['drop table "AUDIT_OLD" cascade constraints;']);
  });
});

describe("planMigration: new tables", () => {
  /** The DDL of PostgreSQL for a table with a foreign key written under its column (the shape `get_ddl` returns). */
  const pgAudit = [
    "create table audit",
    "(",
    "    id     integer not null",
    "        primary key,",
    "    emp_id integer",
    "        constraint audit_emp_fk",
    "        references emp (id) on delete cascade,",
    "    note   text,",
    "    constraint audit_note_check check ((note <> ''::text))",
    ");",
    "create index audit_emp_ix on audit (emp_id);",
  ].join("\n");

  it("creates the table without its foreign key and adds the key after the tables (PostgreSQL)", () => {
    const a = model("postgres", "a", {
      tables: [
        table("emp", { columns: [col("id", "integer", { nullable: false })], primaryKey: key("emp_pkey", ["id"]) }),
        table("audit", {
          columns: [col("id", "integer", { nullable: false }), col("emp_id", "integer"), col("note", "text")],
          primaryKey: key("audit_pkey", ["id"]),
          checks: [{ name: "audit_note_check", expression: "(note <> ''::text)" } as CompareCheck],
          foreignKeys: [fk("audit_emp_fk", { columns: ["emp_id"], refTable: "emp", refColumns: ["id"], onDelete: "CASCADE" })],
          indexes: [index("audit_emp_ix", { columns: ["emp_id"] })],
        }),
      ],
    });
    const b = model("postgres", "b", { tables: [table("emp", { columns: [col("id", "integer", { nullable: false })], primaryKey: key("emp_pkey", ["id"]) })] });
    const plan = planMigration(a, b, undefined, new Map([[tableDdlKey("audit"), pgAudit]]));
    expect(sqlOf(plan, PHASE.create)).toEqual([
      "create table audit\n(\n    id     integer not null\n        primary key,\n    emp_id integer,\n    note   text,\n    constraint audit_note_check check ((note <> ''::text))\n);\ncreate index audit_emp_ix on audit (emp_id);",
    ]);
    expect(sqlOf(plan, PHASE.foreignKeys)).toEqual([
      'alter table "audit" add constraint "audit_emp_fk" foreign key ("emp_id") references "emp" ("id") on delete cascade;',
    ]);
    // the keys and the index come with the DDL: nothing else is generated for the table
    expect(sqlOf(plan, PHASE.keys)).toEqual([]);
    expect(sqlOf(plan, PHASE.indexes)).toEqual([]);
  });

  it("creates the tables in any order and adds each foreign key once, after all of them (Oracle)", () => {
    const a = model("oracle", "A", {
      tables: [
        table("ITEM_TAG", {
          columns: [col("ITEM_ID", "NUMBER(10)", { nullable: false }), col("TAG_ID", "NUMBER(10)", { nullable: false })],
          primaryKey: key("ITEM_TAG_PK", ["ITEM_ID", "TAG_ID"]),
          foreignKeys: [fk("ITEM_TAG_TAG_FK", { columns: ["TAG_ID"], refTable: "TAG", refColumns: ["ID"] })],
        }),
        table("TAG", { columns: [col("ID", "NUMBER(10)", { nullable: false })], primaryKey: key("TAG_PK", ["ID"]) }),
      ],
    });
    const b = model("oracle", "B", { tables: [] });
    const ddl = new Map([
      [tableDdlKey("ITEM_TAG"), 'CREATE TABLE "ITEM_TAG" ("ITEM_ID" NUMBER(10) NOT NULL, "TAG_ID" NUMBER(10) NOT NULL, CONSTRAINT "ITEM_TAG_PK" PRIMARY KEY ("ITEM_ID", "TAG_ID"))'],
      [tableDdlKey("TAG"), 'CREATE TABLE "TAG" ("ID" NUMBER(10) NOT NULL, CONSTRAINT "TAG_PK" PRIMARY KEY ("ID"))'],
    ]);
    const plan = planMigration(a, b, undefined, ddl);
    expect(sqlOf(plan, PHASE.create)).toEqual([
      'CREATE TABLE "ITEM_TAG" ("ITEM_ID" NUMBER(10) NOT NULL, "TAG_ID" NUMBER(10) NOT NULL, CONSTRAINT "ITEM_TAG_PK" PRIMARY KEY ("ITEM_ID", "TAG_ID"));',
      'CREATE TABLE "TAG" ("ID" NUMBER(10) NOT NULL, CONSTRAINT "TAG_PK" PRIMARY KEY ("ID"));',
    ]);
    expect(sqlOf(plan, PHASE.foreignKeys)).toEqual(['alter table "ITEM_TAG" add constraint "ITEM_TAG_TAG_FK" foreign key ("TAG_ID") references "TAG" ("ID");']);
  });

  it("writes no foreign key of a table whose DDL is missing", () => {
    const a = model("oracle", "A", {
      tables: [table("AUDIT", { columns: [col("EMP_ID", "NUMBER(10)")], foreignKeys: [fk("AUDIT_EMP_FK", { columns: ["EMP_ID"], refTable: "EMP", refColumns: ["ID"] })] })],
    });
    const plan = planMigration(a, model("oracle", "B"));
    expect(plan.notes).toEqual(["table AUDIT: the DDL of A is missing; create the table by hand"]);
    expect(plan.statements).toEqual([]);
  });

  it("drops the tables only in B so that a table is dropped before the one it refers to (PostgreSQL)", () => {
    const b = model("postgres", "b", {
      tables: [
        table("parent_old", { columns: [col("id", "integer")] }),
        table("child_old", {
          columns: [col("parent_id", "integer")],
          foreignKeys: [fk("child_fk", { columns: ["parent_id"], refTable: "parent_old", refColumns: ["id"] })],
        }),
      ],
    });
    expect(sqlOf(planMigration(model("postgres", "a"), b), PHASE.drops)).toEqual(['drop table "child_old";', 'drop table "parent_old";']);
  });
});

describe("stripForeignKeys", () => {
  it("cuts the references written under a PostgreSQL column and removes a table-level foreign key", () => {
    const pg = "create table t\n(\n    id integer\n        primary key,\n    c integer\n        constraint t_c_fkey\n        references u (x),\n    constraint t_fk foreign key (id, c) references v (p, q)\n);";
    expect(stripForeignKeys(pg)).toBe("create table t\n(\n    id integer\n        primary key,\n    c integer\n);");
  });

  it("removes the foreign key lines of MySQL, keeping the others and the table options", () => {
    const my = "CREATE TABLE `items` (\n  `id` int NOT NULL,\n  `order_id` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`order_id`),\n  CONSTRAINT `fk_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
    expect(stripForeignKeys(my)).toBe("CREATE TABLE `items` (\n  `id` int NOT NULL,\n  `order_id` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix` (`order_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  });

  it("removes a multi-column table line without touching the commas inside the column list", () => {
    expect(stripForeignKeys("create table t (\n  a int,\n  b int,\n  constraint fk foreign key (a, b) references u (x, y)\n)")).toBe("create table t (\n  a int,\n  b int\n)");
  });

  it("returns text without foreign keys as it is (Oracle's DDL has none) and ignores quoted words", () => {
    const ora = `CREATE TABLE "DEPT" ("ID" NUMBER(10) NOT NULL, "NOTE" VARCHAR2(20) DEFAULT 'references x', CONSTRAINT "PK_DEPT" PRIMARY KEY ("ID"))`;
    expect(stripForeignKeys(ora)).toBe(ora);
  });
});

describe("planMigration: MySQL defaults", () => {
  it("quotes a literal default that is not a number, and keeps numbers and expressions as they are", () => {
    const a = model("mysql", "shop_a", {
      tables: [
        table("items", {
          columns: [
            col("id", "int", { nullable: false }),
            col("status", "varchar(10)", { default: "N", defaultKind: "literal" }),
            col("qty", "int", { default: "5", defaultKind: "literal" }),
            col("created", "timestamp", { default: "CURRENT_TIMESTAMP", defaultKind: "expression" }),
            col("note", "varchar(5)", { default: "it's", defaultKind: "literal" }),
          ],
        }),
      ],
    });
    const b = model("mysql", "shop_b", { tables: [table("items", { columns: [col("id", "int", { nullable: false })] })] });
    expect(sqlOf(planMigration(a, b), PHASE.columns)).toEqual([
      "alter table `items` add column `status` varchar(10) default 'N';",
      "alter table `items` add column `qty` int default 5;",
      "alter table `items` add column `created` timestamp default CURRENT_TIMESTAMP;",
      "alter table `items` add column `note` varchar(5) default 'it''s';",
    ]);
  });
});

describe("planMigration: literal defaults of SQLite and MySQL", () => {
  it("quotes a SQLite literal default that is not a number, doubling its single quotes, and keeps a number", () => {
    const a = model("sqlite", "main", {
      tables: [
        table("t", {
          columns: [
            col("id", "integer", { nullable: false }),
            col("note", "text", { default: "it's", defaultKind: "literal" }),
            col("empty", "text", { default: "", defaultKind: "literal" }),
            col("n", "integer", { default: "7", defaultKind: "literal" }),
            col("path", "text", { default: "a\\b", defaultKind: "literal" }),
          ],
        }),
      ],
    });
    const b = model("sqlite", "main", { tables: [table("t", { columns: [col("id", "integer", { nullable: false })] })] });
    expect(sqlOf(planMigration(a, b), PHASE.columns)).toEqual([
      'alter table "t" add column "note" text default \'it\'\'s\';',
      'alter table "t" add column "empty" text default \'\';',
      'alter table "t" add column "n" integer default 7;',
      "alter table \"t\" add column \"path\" text default 'a\\b';",
    ]);
  });

  it("quotes an empty MySQL literal and escapes the backslashes of a MySQL literal", () => {
    const a = model("mysql", "a", {
      tables: [
        table("t", {
          columns: [col("empty", "varchar(5)", { default: "", defaultKind: "literal" }), col("path", "varchar(9)", { default: "a\\b", defaultKind: "literal" })],
        }),
      ],
    });
    const b = model("mysql", "b", { tables: [table("t")] });
    expect(sqlOf(planMigration(a, b), PHASE.columns)).toEqual([
      "alter table `t` add column `empty` varchar(5) default '';",
      "alter table `t` add column `path` varchar(9) default 'a\\\\b';",
    ]);
  });
});

describe("planMigration: constraint states and index options", () => {
  const one = (driver: Driver, c: CompareCheck) => model(driver, "S", { tables: [table("T", { columns: [col("A", "NUMBER(5)")], checks: [c] })] });
  const ck = (p: Partial<CompareCheck> = {}): CompareCheck => ({ name: "CK_T", expression: "(A > 0)", ...p });

  it("enables or disables an Oracle constraint whose definition is the same, with ENABLE / DISABLE", () => {
    expect(sqlOf(planMigration(one("oracle", ck({ enabled: false })), one("oracle", ck({ enabled: true }))), PHASE.keys)).toEqual([
      'alter table "T" disable constraint "CK_T";',
    ]);
    expect(sqlOf(planMigration(one("oracle", ck({ enabled: true })), one("oracle", ck({ enabled: false }))), PHASE.keys)).toEqual([
      'alter table "T" enable constraint "CK_T";',
    ]);
  });

  it("adds a disabled Oracle constraint disabled", () => {
    const a = model("oracle", "S", { tables: [table("T", { columns: [col("ID", "NUMBER(10)")], primaryKey: { name: "PK_T", columns: ["ID"], enabled: false } })] });
    const b = model("oracle", "S", { tables: [table("T", { columns: [col("ID", "NUMBER(10)")] })] });
    expect(sqlOf(planMigration(a, b), PHASE.keys)).toEqual(['alter table "T" add constraint "PK_T" primary key ("ID") disable;']);
  });

  it("validates a PostgreSQL check that A has validated, and replaces one that A has not validated", () => {
    expect(sqlOf(planMigration(one("postgres", ck({ enabled: true })), one("postgres", ck({ enabled: false }))), PHASE.keys)).toEqual([
      'alter table "T" validate constraint "CK_T";',
    ]);
    const plan = planMigration(one("postgres", ck({ enabled: false })), one("postgres", ck({ enabled: true })));
    expect(sqlOf(plan, PHASE.replace)).toEqual(['alter table "T" drop constraint "CK_T";']);
    expect(sqlOf(plan, PHASE.keys)).toEqual(['alter table "T" add constraint "CK_T" check ((A > 0)) not valid;']);
  });

  it("creates a bitmap index on Oracle and writes the DESC columns", () => {
    const cols = [col("STATUS", "VARCHAR2(5)"), col("SAL", "NUMBER(5)"), col("NAME", "VARCHAR2(5)")];
    const a = model("oracle", "A", {
      tables: [
        table("T", {
          columns: cols,
          indexes: [index("IX_BITMAP", { columns: ["STATUS"], bitmap: true, method: "normal" }), index("IX_DESC", { columns: ["SAL", "NAME"], descending: [true, false] })],
        }),
      ],
    });
    const b = model("oracle", "B", { tables: [table("T", { columns: cols })] });
    expect(sqlOf(planMigration(a, b), PHASE.indexes)).toEqual([
      'create bitmap index "IX_BITMAP" on "T" ("STATUS");',
      'create index "IX_DESC" on "T" ("SAL" desc, "NAME");',
    ]);
  });

  it("replaces an index whose descending flag differs", () => {
    const cols = [col("SAL", "NUMBER(5)"), col("NAME", "VARCHAR2(5)")];
    const a = model("oracle", "A", { tables: [table("T", { columns: cols, indexes: [index("IX_DESC", { columns: ["SAL", "NAME"], descending: [true, false] })] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: cols, indexes: [index("IX_DESC", { columns: ["SAL", "NAME"], descending: [false, false] })] })] });
    const plan = planMigration(a, b);
    expect(sqlOf(plan, PHASE.replace)).toEqual(['drop index "IX_DESC";']);
    expect(sqlOf(plan, PHASE.indexes)).toEqual(['create index "IX_DESC" on "T" ("SAL" desc, "NAME");']);
  });
});

describe("planMigration: keyword case and layout, every dialect", () => {
  const DIALECTS: Driver[] = ["postgres", "mysql", "sqlite", "oracle"];
  const build = (d: Driver) => {
    const a = model(d, "a", {
      tables: [
        table("emp", {
          columns: [
            col("id", "int", { nullable: false }),
            col("name", "varchar(20)", { nullable: false }),
            col("code", "varchar(5)", { default: "'x'" }),
            col("extra", "int", { default: "0", nullable: false }),
          ],
          primaryKey: key("emp_pk", ["id"]),
          unique: [key("emp_code_uq", ["code"])],
          checks: [{ name: "emp_ck", expression: "id > 0" }],
          foreignKeys: [fk("emp_dept_fk", { columns: ["id"], refTable: "dept", refColumns: ["id"], onDelete: "CASCADE" })],
          indexes: [index("emp_name_ix", { columns: ["name"], unique: true })],
        }),
        table("fresh", { columns: [col("id", "int")] }),
      ],
      views: [view("v_emp", "select id from emp")],
      sequences: [{ name: "s_id", incrementBy: "1", minValue: "1", maxValue: "99999", cycle: true, cacheSize: "20" }],
    });
    const b = model(d, "b", {
      tables: [
        table("emp", {
          columns: [col("id", "int", { nullable: false }), col("name", "varchar(10)"), col("code", "varchar(5)"), col("gone", "int")],
          primaryKey: key("emp_pk", ["id", "name"]),
          unique: [key("emp_old_uq", ["name"])],
          checks: [{ name: "emp_ck", expression: "id > 1" }],
          indexes: [index("emp_name_ix", { columns: ["name"] }), index("emp_old_ix", { columns: ["code"] })],
        }),
        table("old", { columns: [col("id", "int")] }),
      ],
      views: [view("v_emp", "select id, name from emp")],
      sequences: [{ name: "s_id", incrementBy: "5", minValue: "1", maxValue: "99999", cycle: false, cacheSize: "1" }],
    });
    const ddl = new Map([[tableDdlKey("fresh"), 'CREATE TABLE "fresh" ("id" int)']]);
    return planMigration(a, b, undefined, ddl);
  };
  /** The statement without its quoted parts (names, literals): what is left are the keywords and the types. */
  const bare = (sql: string) => sql.replace(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|'(?:[^']|'')*'/g, "");

  for (const d of DIALECTS) {
    describe(d, () => {
      const plan = build(d);

      it("writes every statement it generates with lower case keywords", () => {
        const generated = [
          ...plan.header,
          ...plan.statements.filter((s) => s.phase !== PHASE.create && s.phase !== PHASE.views).flatMap((s) => s.sql.split("\n")),
        ];
        expect(generated.length).toBeGreaterThan(d === "sqlite" ? 0 : 8);
        for (const sql of generated) expect(bare(sql), sql).toBe(bare(sql).toLowerCase());
      });

      it("keeps the DDL of a new table as the server wrote it", () => {
        expect(sqlOf(plan, PHASE.create)).toEqual(['CREATE TABLE "fresh" ("id" int);']);
      });

      it("separates the blocks by one blank line, with no doubled blank line, and ends with one newline", () => {
        const text = renderMigration(plan, { includeDrops: true }, { from: "a", to: "b" });
        expect(text).not.toMatch(/\n\n\n/);
        expect(text.endsWith("\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
        const lines = text.split("\n");
        // every statement comment follows a blank line
        lines.forEach((l, i) => {
          if (/^-- (table|view|sequence) /.test(l)) expect(lines[i - 1], l).toBe("");
        });
      });

      it("comments the drops out in lower case too", () => {
        const text = renderMigration(plan, { includeDrops: false }, { from: "a", to: "b" });
        expect(text).not.toMatch(/^-- (DROP|ALTER) /m);
        expect(text).toMatch(/^-- drop /m);
      });
    });
  }

  it("separates the header from the first statement by one blank line (none doubled without a header, SQLite)", () => {
    const text = (d: Driver) => renderMigration(build(d), { includeDrops: true }, { from: "a", to: "b" });
    expect(text("sqlite")).toContain("are included.\n\n-- table ");
    expect(text("postgres")).toContain('are included.\n\nset search_path to "b";\n\n-- table ');
    expect(text("mysql")).toContain("are included.\n\nuse `b`;\n\n-- table ");
    expect(text("oracle")).toContain('are included.\n\nalter session set current_schema = "b";\n\n-- table ');
  });

  it("quotes names with the quote of the dialect, doubling a quote inside the name", () => {
    const my = (cols: CompareColumn[]) => model("mysql", "s", { tables: [table("t", { columns: cols })] });
    expect(sqlOf(planMigration(my([col("id", "int"), col("a`b", "int")]), my([col("id", "int")])), PHASE.columns)).toEqual(["alter table `t` add column `a``b` int;"]);
    const pg = (cols: CompareColumn[]) => model("postgres", "s", { tables: [table("t", { columns: cols })] });
    expect(sqlOf(planMigration(pg([col("id", "int"), col('a"b', "int")]), pg([col("id", "int")])), PHASE.columns)).toEqual(['alter table "t" add column "a""b" int;']);
  });
});
