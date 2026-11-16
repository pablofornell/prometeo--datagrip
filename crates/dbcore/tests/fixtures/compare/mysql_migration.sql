-- Migration: make B like A (MySQL)
-- Generated from the schema compare. Review it before you run it.
-- Statements that drop objects are included.

use `cmpx_b`;

-- table tag: create (from A)
CREATE TABLE `tag` (
  `id` int NOT NULL,
  `name` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `tag_name_ix` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- table item_tag: create (from A)
CREATE TABLE `item_tag` (
  `item_id` int NOT NULL,
  `tag_id` int NOT NULL,
  PRIMARY KEY (`item_id`,`tag_id`),
  KEY `item_tag_tag_fk` (`tag_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- table audit: create (from A)
CREATE TABLE `audit` (
  `id` int NOT NULL,
  `emp_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `audit_emp_fk` (`emp_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- table order_lines: foreign key order_lines_order_fk (dropped before primary key (id) is replaced)
alter table `order_lines` drop foreign key `order_lines_order_fk`;

-- table emp: check emp_salary_ck: replace
alter table `emp` drop check `emp_salary_ck`;

-- table emp: index emp_name_ix: replace
drop index `emp_name_ix` on `emp`;

-- table emp: index emp_old_ix (only in B)
drop index `emp_old_ix` on `emp`;

-- table orders: primary key (id, ref): replace
alter table `orders` drop primary key;

-- table emp: change column name
alter table `emp` modify column `name` varchar(80) not null;

-- table emp: change column code
alter table `emp` modify column `code` varchar(10);

-- table emp: change column salary
alter table `emp` modify column `salary` decimal(10,2) default 0;

-- table emp: add column status
alter table `emp` add column `status` varchar(10) default 'new' not null;

-- table dept: add unique dept_name_key
alter table `dept` add constraint `dept_name_key` unique (`name`);

-- table emp: add unique emp_code_key
alter table `emp` add constraint `emp_code_key` unique (`code`);

-- table emp: check emp_salary_ck: replace
alter table `emp` add constraint `emp_salary_ck` check ((`salary` >= 0));

-- table orders: primary key (id, ref): replace
alter table `orders` add primary key (`id`, `ref`);

-- table orders: add unique orders_id_uq
alter table `orders` add constraint `orders_id_uq` unique (`id`);

-- table order_lines: foreign key order_lines_order_fk: add again after the key is replaced
alter table `order_lines` add constraint `order_lines_order_fk` foreign key (`order_id`) references `orders` (`id`);

-- table item_tag: foreign key item_tag_tag_fk
alter table `item_tag` add constraint `item_tag_tag_fk` foreign key (`tag_id`) references `tag` (`id`);

-- table audit: foreign key audit_emp_fk
alter table `audit` add constraint `audit_emp_fk` foreign key (`emp_id`) references `emp` (`id`);

-- table emp: index emp_name_ix: replace
create index `emp_name_ix` on `emp` (`name`);

-- view v_emp: replace
create or replace view `v_emp` as select `emp`.`id` AS `id`,`emp`.`name` AS `name` from `emp`;

-- table emp: drop column old_flag (only in B)
alter table `emp` drop column `old_flag`;

-- table old_log: only in B
drop table `old_log`;
