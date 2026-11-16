-- Migration: make B like A (Oracle)
-- Generated from the schema compare. Review it before you run it.
-- Statements that drop objects are included.

alter session set current_schema = "DEMO";

-- table CMPX_TAG: create (from A)
CREATE TABLE "CMPX_TAG"
   (	"ID" NUMBER(10,0) NOT NULL ENABLE,
	"NAME" VARCHAR2(20),
	CONSTRAINT "CMPX_TAG_PK" PRIMARY KEY ("ID")
   );

CREATE INDEX "CMPX_TAG_NAME_IX" ON "CMPX_TAG" ("NAME");

-- table CMPX_ITEM_TAG: create (from A)
CREATE TABLE "CMPX_ITEM_TAG"
   (	"ITEM_ID" NUMBER(10,0) NOT NULL ENABLE,
	"TAG_ID" NUMBER(10,0) NOT NULL ENABLE,
	CONSTRAINT "CMPX_ITEM_TAG_PK" PRIMARY KEY ("ITEM_ID", "TAG_ID")
   );

-- table CMPX_AUDIT: create (from A)
CREATE TABLE "CMPX_AUDIT"
   (	"ID" NUMBER(10,0) NOT NULL ENABLE,
	"EMP_ID" NUMBER(10,0) NOT NULL ENABLE,
	CONSTRAINT "CMPX_AUDIT_PK" PRIMARY KEY ("ID")
   );

-- table CMPX_ORDER_LINES: foreign key CMPX_LINES_ORDER_FK (dropped before primary key (ID) is replaced)
alter table "CMPX_ORDER_LINES" drop constraint "CMPX_LINES_ORDER_FK";

-- table CMPX_EMP: check CMPX_EMP_SALARY_CK: replace
alter table "CMPX_EMP" drop constraint "CMPX_EMP_SALARY_CK";

-- table CMPX_EMP: index CMPX_EMP_NAME_IX: replace
drop index "CMPX_EMP_NAME_IX";

-- table CMPX_EMP: index CMPX_EMP_SAL_IX: replace
drop index "CMPX_EMP_SAL_IX";

-- table CMPX_EMP: index CMPX_EMP_OLD_IX (only in B)
drop index "CMPX_EMP_OLD_IX";

-- table CMPX_ORDERS: primary key (ID) (replaced: same definition in A under another name)
alter table "CMPX_ORDERS" drop primary key;

-- table CMPX_EMP: change column NAME
alter table "CMPX_EMP" modify ("NAME" VARCHAR2(80) not null);

-- table CMPX_EMP: change column CODE
alter table "CMPX_EMP" modify ("CODE" null);

-- table CMPX_EMP: change column SALARY
alter table "CMPX_EMP" modify ("SALARY" default 0);

-- table CMPX_EMP: add column STATUS
alter table "CMPX_EMP" add ("STATUS" VARCHAR2(10) default 'new' not null);

-- table CMPX_DEPT: add unique CMPX_DEPT_NAME_UQ
alter table "CMPX_DEPT" add constraint "CMPX_DEPT_NAME_UQ" unique ("NAME");

-- table CMPX_EMP: add unique CMPX_EMP_CODE_UQ
alter table "CMPX_EMP" add constraint "CMPX_EMP_CODE_UQ" unique ("CODE");

-- table CMPX_EMP: check CMPX_EMP_SALARY_CK: replace
alter table "CMPX_EMP" add constraint "CMPX_EMP_SALARY_CK" check (SALARY >= 0);

-- table CMPX_ORDERS: add primary key (ID)
alter table "CMPX_ORDERS" add constraint "CMPX_ORDERS_PK" primary key ("ID");

-- table CMPX_ORDER_LINES: foreign key CMPX_LINES_ORDER_FK: add again after the key is replaced
alter table "CMPX_ORDER_LINES" add constraint "CMPX_LINES_ORDER_FK" foreign key ("ORDER_ID") references "CMPX_ORDERS" ("ID");

-- table CMPX_ITEM_TAG: foreign key CMPX_ITEM_TAG_TAG_FK
alter table "CMPX_ITEM_TAG" add constraint "CMPX_ITEM_TAG_TAG_FK" foreign key ("TAG_ID") references "CMPX_TAG" ("ID");

-- table CMPX_AUDIT: foreign key CMPX_AUDIT_EMP_FK
alter table "CMPX_AUDIT" add constraint "CMPX_AUDIT_EMP_FK" foreign key ("EMP_ID") references "CMPX_EMP" ("ID");

-- table CMPX_EMP: index CMPX_EMP_NAME_IX: replace
create index "CMPX_EMP_NAME_IX" on "CMPX_EMP" ("NAME");

-- table CMPX_EMP: index CMPX_EMP_SAL_IX: replace
create index "CMPX_EMP_SAL_IX" on "CMPX_EMP" ("SALARY" desc);

-- table CMPX_EMP: add index CMPX_EMP_STATUS_BX
create bitmap index "CMPX_EMP_STATUS_BX" on "CMPX_EMP" ("STATUS");

-- view CMPX_V_EMP: replace
create or replace view "CMPX_V_EMP" as select ID, NAME from CMPX_EMP;

-- table CMPX_EMP: drop column OLD_FLAG (only in B)
alter table "CMPX_EMP" drop column "OLD_FLAG";

-- table CMPX_OLD_LOG: only in B
drop table "CMPX_OLD_LOG" cascade constraints;
