create table if not exists tenants (
  id              text primary key,
  name            text not null,
  db_host         text not null,
  db_port         int  not null default 5432,
  db_name         text not null,
  db_user         text not null,
  db_ro_user      text not null,
  enc_password    bytea not null,  -- AES-GCM(JSON {rw, ro}) under a per-row data key
  enc_data_key    bytea not null,  -- data key wrapped by the master key (file locally, KMS on AWS)
  rate_limit_rps  int  not null default 50,
  max_concurrency int  not null default 5
);

create table if not exists callers (
  id           serial primary key,
  tenant_id    text references tenants(id),  -- null = valid for every tenant
  type         text not null check (type in ('console', 'mcp', 'agent', 'admin', 'worker')),
  api_key_hash text not null unique,         -- sha256 hex; plaintext keys are never stored
  role         text not null default 'user'
);

create table if not exists branches (
  project      text not null,
  branch       text not null,
  config       jsonb not null default '{}',
  enc_secrets  bytea,
  enc_data_key bytea,
  updated_at   timestamptz not null default now(),
  primary key (project, branch)
);
