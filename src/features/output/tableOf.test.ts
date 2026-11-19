// @vitest-environment node
/** `sqlTableRef`: which results `Generate SQL` may write statements for (one table, no renamed or computed columns). */
import { describe, expect, it, vi } from "vitest";
import type { ColumnMeta } from "../../api/types";

vi.mock("../../api/db", () => ({ introspect: async () => [] }));
import type { OutputHost, ResultTab } from "./model";
import { sqlTableRef } from "./tableOf";

const m = (name: string, tableRef: string | null): ColumnMeta => ({ name, tableRef, typeName: "int", nullable: true, isPk: false });
const host = (driver: string, schema: string | null = null) => ({ driver, schema: () => schema }) as unknown as OutputHost;
const tab = (sql: string, meta: ColumnMeta[], edit: unknown = null) => ({ sql, meta, edit: () => edit }) as unknown as ResultTab;
const pg = (names: string[], ref: string | null = "public.emp") => names.map((n) => m(n, ref));

describe("sqlTableRef, results that are not one table's rows", () => {
  it("rejects a join and a comma list", () => {
    expect(sqlTableRef(tab("select * from emp e join dept d on d.id = e.dept", pg(["id", "dept"])), host("postgres"))).toBeNull();
    expect(sqlTableRef(tab("select id from emp, dept", [m("id", null)]), host("mysql"))).toBeNull();
  });
  it("rejects a PostgreSQL self-join (both sides report the same table)", () => {
    const meta = [m("id", "public.emp"), m("name", "public.emp"), m("id", "public.emp"), m("name", "public.emp")];
    expect(sqlTableRef(tab("select * from emp e join emp mgr on mgr.id = e.mgr_id", meta), host("postgres"))).toBeNull();
  });
  it("rejects duplicate result column names", () => {
    expect(sqlTableRef(tab("select id, id from emp", pg(["id", "id"])), host("postgres"))).toBeNull();
    expect(sqlTableRef(tab("select a.id, a.ID from emp a", [m("id", null), m("ID", null)]), host("sqlite"))).toBeNull();
  });
  it("rejects aliases that rename a column", () => {
    expect(sqlTableRef(tab("select customer_id as id, total from orders", pg(["id", "total"], "public.orders")), host("postgres"))).toBeNull();
    expect(sqlTableRef(tab("select customer_id id from orders", [m("id", null)]), host("mysql"))).toBeNull();
  });
  it("rejects expressions and aggregates", () => {
    expect(sqlTableRef(tab("select id + 1 as id, name from emp", pg(["id", "name"])), host("postgres"))).toBeNull();
    expect(sqlTableRef(tab("select id + 1 as id from emp", [m("id", null)]), host("mysql"))).toBeNull();
    expect(sqlTableRef(tab("select count(*) as n from emp", [m("n", null)]), host("sqlite"))).toBeNull();
    expect(sqlTableRef(tab("select distinct id from emp", [m("id", null)]), host("sqlite"))).toBeNull();
  });
  it("rejects a PostgreSQL column that reports no table", () => {
    expect(sqlTableRef(tab("select id, name from emp", [m("id", "public.emp"), m("name", null)]), host("postgres"))).toBeNull();
  });
  it("is null without a host", () => {
    expect(sqlTableRef(tab("select * from emp", pg(["id"])), undefined)).toBeNull();
  });
});

describe("sqlTableRef, results that are", () => {
  it("a plain select of one table gives SELECT and INSERT only", () => {
    const t = sqlTableRef(tab("select * from emp where id > 3", pg(["id", "name"])), host("postgres"));
    expect(t?.table).toEqual({ schema: "public", name: "emp", kind: "table" });
    expect(t?.kinds).toEqual(["select", "insert"]);
  });
  it("accepts listed columns, qualified, with a same-name alias and a star in the middle", () => {
    expect(sqlTableRef(tab("select e.id, name as name from emp e", [m("id", null), m("name", null)]), host("sqlite"))?.table).toEqual({ schema: "main", name: "emp", kind: "table" });
    expect(sqlTableRef(tab("select id, *, note from emp", [m("id", null), m("id", null), m("a", null), m("note", null)]), host("mysql"))).toBeNull(); // duplicate id
    expect(sqlTableRef(tab("select id, *, note from emp", [m("id", null), m("a", null), m("b", null), m("note", null)]), host("mysql", "demo"))?.table.name).toBe("emp");
  });
  it("an editable result gets all four statements and its resolved table (no case folding)", () => {
    const edit = { table: { schema: "App", name: "Emp", kind: "table" }, key: ["id"], editable: [true] };
    const t = sqlTableRef(tab("select * from emp", [m("id", null)], edit), host("oracle"));
    expect(t).toEqual({ table: { schema: "App", name: "Emp", kind: "table" }, kinds: ["select", "insert", "update", "delete"] });
  });
});

describe("sqlTableRef, Oracle names", () => {
  it("keeps the case of a quoted name and upper-cases an unquoted one", () => {
    expect(sqlTableRef(tab('select * from "Emp"', [m("ID", null)]), host("oracle", "APP"))?.table).toEqual({ schema: "APP", name: "Emp", kind: "table" });
    expect(sqlTableRef(tab("select * from emp", [m("ID", null)]), host("oracle", "APP"))?.table).toEqual({ schema: "APP", name: "EMP", kind: "table" });
  });
  it("folds each part of a qualified name on its own", () => {
    expect(sqlTableRef(tab('select * from hr."Emp"', [m("ID", null)]), host("oracle"))?.table).toEqual({ schema: "HR", name: "Emp", kind: "table" });
    expect(sqlTableRef(tab('select * from "hr".emp', [m("ID", null)]), host("oracle"))?.table).toEqual({ schema: "hr", name: "EMP", kind: "table" });
  });
});
