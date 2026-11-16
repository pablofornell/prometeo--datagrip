-- Migration: make B like A (PostgreSQL)
-- Generated from the schema compare. Review it before you run it.
-- Statements that drop objects are included.

set search_path to "cmpx_b";

-- table tag: create (from A)
-- auto-generated definition
create table tag
(
    id   integer not null
        primary key,
    name varchar(20)
);

create index tag_name_ix on tag using btree (name);

-- table item_tag: create (from A)
-- auto-generated definition
create table item_tag
(
    item_id integer not null,
    tag_id  integer not null,
    constraint item_tag_pkey primary key (item_id, tag_id)
);

-- table audit: create (from A)
-- auto-generated definition
create table audit
(
    id     integer not null
        primary key,
    emp_id integer not null
);

-- table order_lines: foreign key order_lines_order_fk (dropped before primary key (id) is replaced)
alter table "order_lines" drop constraint "order_lines_order_fk";

-- table emp: check emp_salary_ck: replace
alter table "emp" drop constraint "emp_salary_ck";

-- table emp: index emp_name_ix: replace
drop index "emp_name_ix";

-- table emp: index emp_salary_ix: replace
drop index "emp_salary_ix";

-- table emp: index emp_old_ix (only in B)
drop index "emp_old_ix";

-- table orders: primary key (id) (replaced: same definition in A under another name)
alter table "orders" drop constraint "orders_pkey_old";

-- table emp: change column name
alter table "emp" alter column "name" type varchar(80);

-- table emp: change column name
alter table "emp" alter column "name" set not null;

-- table emp: change column code
alter table "emp" alter column "code" drop not null;

-- table emp: change column salary
alter table "emp" alter column "salary" set default 0;

-- table emp: add column status
alter table "emp" add column "status" varchar(10) default 'new'::character varying not null;

-- table dept: add unique dept_name_key
alter table "dept" add constraint "dept_name_key" unique ("name");

-- table emp: add unique emp_code_key
alter table "emp" add constraint "emp_code_key" unique ("code");

-- table emp: check emp_salary_ck: replace
alter table "emp" add constraint "emp_salary_ck" check ((salary >= (0)::numeric));

-- table orders: add primary key (id)
alter table "orders" add constraint "orders_pkey" primary key ("id");

-- table order_lines: foreign key order_lines_order_fk: add again after the key is replaced
alter table "order_lines" add constraint "order_lines_order_fk" foreign key ("order_id") references "orders" ("id");

-- table item_tag: foreign key item_tag_tag_fk
alter table "item_tag" add constraint "item_tag_tag_fk" foreign key ("tag_id") references "tag" ("id");

-- table audit: foreign key audit_emp_fk
alter table "audit" add constraint "audit_emp_fk" foreign key ("emp_id") references "emp" ("id");

-- table emp: index emp_name_ix: replace
create index "emp_name_ix" on "emp" ("name");

-- table emp: index emp_salary_ix: replace
create index "emp_salary_ix" on "emp" ("salary" desc);

-- view v_emp: replace
create or replace view "v_emp" as SELECT emp.id, emp.name FROM emp;

-- table emp: drop column old_flag (only in B)
alter table "emp" drop column "old_flag";

-- table old_log: only in B
drop table "old_log";
