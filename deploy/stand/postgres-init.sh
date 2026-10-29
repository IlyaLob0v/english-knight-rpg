#!/bin/sh
# First start of the stand's Postgres: a database and a role for the LRS, next to the gateway's.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE lrsql LOGIN PASSWORD '$POSTGRES_PASSWORD';
CREATE DATABASE lrsql OWNER lrsql;
SQL
