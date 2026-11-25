-- Synthetic sample data (~55k rows). __TENANT__ is replaced by the tenant id.
create table customers (
  id         serial primary key,
  name       text not null,
  email      text not null,
  country    text not null,
  created_at timestamptz not null default now()
);
create table products (
  id       serial primary key,
  name     text not null,
  category text not null,
  price    numeric(10,2) not null
);
create table orders (
  id          serial primary key,
  customer_id int not null references customers(id),
  product_id  int not null references products(id),
  quantity    int not null,
  total       numeric(12,2) not null,
  status      text not null,
  created_at  timestamptz not null default now()
);
create index orders_customer_idx on orders(customer_id);
create index orders_created_idx on orders(created_at);

insert into customers (name, email, country, created_at)
select '__TENANT__ customer ' || g, 'customer' || g || '@__TENANT__.example.test',
       (array['AU','ID','SG','US','DE','JP'])[1 + g % 6], now() - (g || ' minutes')::interval
from generate_series(1, 5000) g;

insert into products (name, category, price)
select 'product ' || g, (array['tools','books','toys','food','garden'])[1 + g % 5], round((5 + random() * 495)::numeric, 2)
from generate_series(1, 500) g;

insert into orders (customer_id, product_id, quantity, total, status, created_at)
select 1 + (random() * 4999)::int, 1 + (random() * 499)::int, q, round((q * (5 + random() * 495))::numeric, 2),
       (array['new','paid','shipped','refunded'])[1 + (random() * 3)::int], now() - ((random() * 90 * 24 * 60)::int || ' minutes')::interval
from (select 1 + (random() * 4)::int as q from generate_series(1, 50000)) s;

analyze;
