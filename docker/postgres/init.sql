-- One Postgres for the local stack, one database and role per service.
-- Dev passwords only: this stack is for local testing, never for real student data.
CREATE ROLE moonbridge LOGIN PASSWORD 'moonbridge';
CREATE DATABASE moonbridge OWNER moonbridge;
CREATE ROLE moodle LOGIN PASSWORD 'moodle';
CREATE DATABASE moodle OWNER moodle ENCODING 'UTF8';
CREATE ROLE lrsql LOGIN PASSWORD 'lrsql';
CREATE DATABASE lrsql OWNER lrsql;
