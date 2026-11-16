/**
 * Sample schemas for the diagram tests and for trying the view by hand: a realistic shop / identity / inventory
 * schema, and a seeded random generator for stress tests. Not imported by the app.
 */
import type { DiagramForeignKey, DiagramInputObject } from "./model";

/** `["id pk bigint", "owner_id fk users.id bigint", "name varchar(80)"]` -> columns + foreign keys of one table. */
function table(schema: string, name: string, spec: string[], kind: DiagramInputObject["kind"] = "table"): DiagramInputObject {
  const columns: DiagramInputObject["columns"] = [];
  const foreignKeys: DiagramForeignKey[] = [];
  for (const s of spec) {
    const [col, ...rest] = s.split(" ");
    let isPk = false;
    let type = "text";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "pk") isPk = true;
      else if (rest[i] === "fk") {
        const [refTable, refCol] = rest[++i].split(".");
        foreignKeys.push({ name: `${name}_${col}_fkey`, columns: [col], refSchema: schema, refTable, refColumns: [refCol] });
      } else type = rest[i];
    }
    columns.push({ name: col, typeName: type, isPk });
  }
  return { schema, name, kind, columns, foreignKeys };
}

export function shopSchema(schema = "shop"): DiagramInputObject[] {
  const t = (name: string, spec: string[], kind?: DiagramInputObject["kind"]) => table(schema, name, spec, kind);
  const ts = "timestamptz";
  return [
    t("countries", ["code pk char(2)", "name varchar(120)", "currency char(3)"]),
    t("roles", ["id pk int", "name varchar(40)", "description text"]),
    t("permissions", ["id pk int", "code varchar(80)", "description text"]),
    t("role_permissions", ["role_id pk fk roles.id int", "permission_id pk fk permissions.id int"]),
    t("users", ["id pk bigint", "email varchar(255)", "password_hash varchar(128)", "full_name varchar(120)", "country_code fk countries.code char(2)", "created_at " + ts, "last_login_at " + ts]),
    t("user_roles", ["user_id pk fk users.id bigint", "role_id pk fk roles.id int", "granted_at " + ts]),
    t("sessions", ["id pk uuid", "user_id fk users.id bigint", "ip inet", "user_agent text", "expires_at " + ts]),
    t("audit_log", ["id pk bigint", "user_id fk users.id bigint", "action varchar(60)", "entity varchar(60)", "entity_id bigint", "at " + ts]),
    t("customers", ["id pk bigint", "user_id fk users.id bigint", "phone varchar(32)", "loyalty_points int", "birth_date date"]),
    t("addresses", ["id pk bigint", "customer_id fk customers.id bigint", "country_code fk countries.code char(2)", "line1 varchar(160)", "line2 varchar(160)", "city varchar(80)", "postal_code varchar(16)"]),
    t("categories", ["id pk int", "parent_id fk categories.id int", "name varchar(80)", "slug varchar(80)"]),
    t("brands", ["id pk int", "name varchar(80)", "country_code fk countries.code char(2)"]),
    t("suppliers", ["id pk int", "name varchar(120)", "contact_email varchar(255)", "country_code fk countries.code char(2)"]),
    t("products", ["id pk bigint", "sku varchar(32)", "name varchar(255)", "category_id fk categories.id int", "brand_id fk brands.id int", "supplier_id fk suppliers.id int", "price numeric(10,2)", "active boolean", "description text", "created_at " + ts]),
    t("product_images", ["id pk bigint", "product_id fk products.id bigint", "url varchar(500)", "position int"]),
    t("tags", ["id pk int", "label varchar(40)"]),
    t("product_tags", ["product_id pk fk products.id bigint", "tag_id pk fk tags.id int"]),
    t("coupons", ["id pk int", "code varchar(24)", "percent_off int", "valid_until date"]),
    t("orders", ["id pk bigint", "customer_id fk customers.id bigint", "ship_address_id fk addresses.id bigint", "bill_address_id fk addresses.id bigint", "status varchar(20)", "total numeric(12,2)", "placed_at " + ts]),
    t("order_items", ["order_id pk fk orders.id bigint", "line_no pk int", "product_id fk products.id bigint", "qty int", "unit_price numeric(10,2)"]),
    t("order_coupons", ["order_id pk fk orders.id bigint", "coupon_id pk fk coupons.id int"]),
    t("payments", ["id pk bigint", "order_id fk orders.id bigint", "method varchar(20)", "amount numeric(12,2)", "paid_at " + ts]),
    t("shipments", ["id pk bigint", "order_id fk orders.id bigint", "carrier varchar(40)", "tracking_no varchar(64)", "shipped_at " + ts]),
    t("invoices", ["id pk bigint", "order_id fk orders.id bigint", "number varchar(24)", "issued_at date", "pdf bytea"]),
    t("warehouses", ["id pk int", "name varchar(80)", "country_code fk countries.code char(2)"]),
    t("stock_levels", ["warehouse_id pk fk warehouses.id int", "product_id pk fk products.id bigint", "on_hand int", "reserved int"]),
    t("stock_movements", ["id pk bigint", "warehouse_id fk warehouses.id int", "product_id fk products.id bigint", "delta int", "reason varchar(40)", "at " + ts]),
    t("employees", ["id pk int", "manager_id fk employees.id int", "user_id fk users.id bigint", "title varchar(80)"]),
    t("settings", ["key pk varchar(80)", "value text"]),
    t("schema_migrations", ["version pk varchar(32)", "applied_at " + ts]),
    t("v_order_totals", ["order_id bigint", "customer varchar(255)", "total numeric"], "view"),
    t("mv_sales_by_category", ["category varchar(100)", "revenue numeric"], "materializedView"),
  ];
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random schema: `n` tables with 1..`maxCols` columns of varying name length and a random foreign key graph (cycles, self references and isolated tables included). */
export function randomSchema(seed: number, n: number, opts: { maxCols?: number; density?: number } = {}): DiagramInputObject[] {
  const rand = rng(seed);
  const maxCols = opts.maxCols ?? 14;
  const density = opts.density ?? 1.3;
  const names = Array.from({ length: n }, (_, i) => `t${i}_${"x".repeat(Math.floor(rand() * 18))}`);
  return names.map((name, i) => {
    const ncols = 1 + Math.floor(rand() * maxCols);
    const columns = Array.from({ length: ncols }, (_, c) => ({ name: `${"c".repeat(1 + Math.floor(rand() * 14))}_${c}`, typeName: rand() < 0.3 ? "character varying(255)" : "int", isPk: c === 0 }));
    const foreignKeys: DiagramForeignKey[] = [];
    const k = rand() < 0.15 ? 0 : Math.floor(rand() * density * 2);
    for (let j = 0; j < k && ncols > 1; j++) {
      const target = Math.floor(rand() * n);
      const col = columns[1 + Math.floor(rand() * (ncols - 1))].name;
      foreignKeys.push({ name: `fk_${i}_${j}`, columns: [col], refSchema: "s", refTable: names[target], refColumns: [columns[0].name] });
    }
    return { schema: "s", name, kind: "table" as const, columns, foreignKeys };
  });
}
