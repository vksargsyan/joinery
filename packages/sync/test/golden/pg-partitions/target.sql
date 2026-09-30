create table measurements (id bigint not null, taken date not null, value double precision) partition by range (taken);
create table measurements_2023 partition of measurements for values from ('2023-01-01') to ('2024-01-01');
create table measurements_2024 partition of measurements for values from ('2024-01-01') to ('2025-01-01');
