create table measurements (id bigint not null, taken date not null, value double precision, unit text) partition by range (taken);
create table measurements_2024 partition of measurements for values from ('2024-01-01') to ('2025-01-01');
create table measurements_2025 partition of measurements for values from ('2025-01-01') to ('2026-01-01');
create table logs (at timestamptz not null, line text) partition by list (line);
create table logs_default partition of logs default;
