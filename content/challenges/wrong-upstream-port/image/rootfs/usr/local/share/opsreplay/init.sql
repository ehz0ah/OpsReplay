CREATE ROLE shop LOGIN;
CREATE DATABASE shop OWNER shop;
\connect shop
SET ROLE shop;
CREATE TABLE orders (
    id text PRIMARY KEY,
    reference varchar(128) NOT NULL,
    status text NOT NULL CHECK (status = 'confirmed'),
    created_at timestamptz NOT NULL DEFAULT now()
);
