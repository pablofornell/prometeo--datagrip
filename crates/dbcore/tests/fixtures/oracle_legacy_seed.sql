-- Datum test fixture for old Oracle servers (10g / 11g): only SQL that 10.2 knows (no identity
-- columns, no JSON, no virtual columns). Objects are named LG_*. Idempotent: the objects are dropped first.
-- Statements end with ';', PL/SQL units and blocks with a line holding only '/'.

BEGIN
    FOR o IN (
        SELECT 'VIEW' t, 'LG_EMP_V' n FROM dual UNION ALL
        SELECT 'SEQUENCE', 'LG_SEQ' FROM dual UNION ALL
        SELECT 'PROCEDURE', 'LG_RAISE' FROM dual UNION ALL
        SELECT 'FUNCTION', 'LG_COUNT' FROM dual UNION ALL
        SELECT 'PACKAGE', 'LG_PKG' FROM dual UNION ALL
        SELECT 'TABLE', 'LG_EMP' FROM dual UNION ALL
        SELECT 'TABLE', 'LG_DEPT' FROM dual UNION ALL
        SELECT 'TABLE', 'LG_NOTES' FROM dual UNION ALL
        SELECT 'TABLE', 'LG_NOPK' FROM dual UNION ALL
        SELECT 'TABLE', 'LG_EDIT' FROM dual
    ) LOOP
        BEGIN
            EXECUTE IMMEDIATE 'DROP ' || o.t || ' "' || o.n || '"' ||
                CASE o.t WHEN 'TABLE' THEN ' CASCADE CONSTRAINTS PURGE' ELSE '' END;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    END LOOP;
END;
/

CREATE TABLE lg_dept (
    id      NUMBER(10) CONSTRAINT lg_dept_pk PRIMARY KEY,
    name    VARCHAR2(50) NOT NULL CONSTRAINT lg_dept_name_uq UNIQUE,
    created DATE DEFAULT SYSDATE,
    note    VARCHAR2(200) DEFAULT 'none' NOT NULL
);
COMMENT ON TABLE lg_dept IS 'Departments';
COMMENT ON COLUMN lg_dept.name IS 'Department name';

CREATE TABLE lg_emp (
    id      NUMBER(10) CONSTRAINT lg_emp_pk PRIMARY KEY,
    dept_id NUMBER(10) CONSTRAINT lg_emp_dept_fk REFERENCES lg_dept (id) ON DELETE CASCADE,
    name    VARCHAR2(100) NOT NULL,
    salary  NUMBER(12,2) CONSTRAINT lg_emp_salary_ck CHECK (salary > 0),
    hired   TIMESTAMP(6),
    bio     CLOB
);
CREATE INDEX lg_emp_name_ix ON lg_emp (name, id DESC);

-- one LONG column, read through the ROWNUM paging
CREATE TABLE lg_notes (
    id   NUMBER(10) PRIMARY KEY,
    body LONG
);

-- no primary key: rows are found by ROWID
CREATE TABLE lg_nopk (
    a NUMBER,
    b VARCHAR2(20)
);

-- edited by the tests
CREATE TABLE lg_edit (
    id NUMBER(10) PRIMARY KEY,
    t  VARCHAR2(4000),
    c  CLOB,
    b  BLOB
);

CREATE SEQUENCE lg_seq START WITH 10 INCREMENT BY 5;

CREATE OR REPLACE VIEW lg_emp_v AS
SELECT e.id, e.name, d.name AS dept_name FROM lg_emp e JOIN lg_dept d ON d.id = e.dept_id;

CREATE OR REPLACE PROCEDURE lg_raise(p_id IN NUMBER, p_pct IN NUMBER) IS
BEGIN
    UPDATE lg_emp SET salary = salary * (1 + p_pct / 100) WHERE id = p_id;
END;
/

CREATE OR REPLACE FUNCTION lg_count(p_dept NUMBER) RETURN NUMBER IS
    n NUMBER;
BEGIN
    SELECT count(*) INTO n FROM lg_emp WHERE dept_id = p_dept;
    RETURN n;
END;
/

CREATE OR REPLACE PACKAGE lg_pkg AS
    PROCEDURE zeta(a NUMBER);
    FUNCTION alpha(b VARCHAR2) RETURN VARCHAR2;
END lg_pkg;
/

CREATE OR REPLACE PACKAGE BODY lg_pkg AS
    PROCEDURE zeta(a NUMBER) IS
    BEGIN
        NULL;
    END;
    FUNCTION alpha(b VARCHAR2) RETURN VARCHAR2 IS
    BEGIN
        RETURN upper(b);
    END;
END lg_pkg;
/

CREATE OR REPLACE TRIGGER lg_emp_trg BEFORE INSERT ON lg_emp FOR EACH ROW
BEGIN
    IF :new.hired IS NULL THEN
        :new.hired := systimestamp;
    END IF;
END;
/

INSERT INTO lg_dept (id, name) VALUES (1, 'Sales');
INSERT INTO lg_dept (id, name, note) VALUES (2, 'R&D <lab>', 'x');
INSERT INTO lg_emp (id, dept_id, name, salary)
    SELECT level, mod(level, 2) + 1, 'emp ' || lpad(level, 4, '0'), 1000 + level FROM dual CONNECT BY level <= 1200;
INSERT INTO lg_notes VALUES (1, 'first note');
-- a LONG value longer than a SQL string can be (4000)
DECLARE
    v VARCHAR2(32767) := rpad('long ', 6000, 'x');
BEGIN
    INSERT INTO lg_notes VALUES (2, v);
END;
/
INSERT INTO lg_nopk VALUES (1, 'one');
INSERT INTO lg_nopk VALUES (2, 'two');
INSERT INTO lg_nopk VALUES (3, 'three');
COMMIT;
