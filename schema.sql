-- schema.sql — correr esto una sola vez en Supabase: Project > SQL Editor > New query > pegar > Run

create table if not exists profesionales (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id),
  slug text unique not null,              -- usado en la URL del webhook, ej: "juan-ecom"
  nombre text not null,
  rubro text,
  system_prompt text not null,            -- el prompt completo del setter para este profesional
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists conversaciones (
  id uuid primary key default gen_random_uuid(),
  profesional_id uuid not null references profesionales(id) on delete cascade,
  subscriber_id text not null,            -- id del suscriptor en Manychat
  lead_nombre text,
  etapa text default 'inicio',
  status text default 'conversando',
  score int default 0,
  oferta_presentada text,
  dia_propuesto text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profesional_id, subscriber_id)
);

create table if not exists mensajes (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references conversaciones(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Seguridad: cada profesional ve solo lo suyo; el/los admin ven todo.
alter table profesionales enable row level security;
alter table conversaciones enable row level security;
alter table mensajes enable row level security;

create policy "ver mi propio perfil o todos si soy admin"
  on profesionales for select
  using (
    auth_user_id = auth.uid()
    or exists (select 1 from profesionales p where p.auth_user_id = auth.uid() and p.is_admin)
  );

create policy "ver mis conversaciones o todas si soy admin"
  on conversaciones for select
  using (
    profesional_id in (select id from profesionales where auth_user_id = auth.uid())
    or exists (select 1 from profesionales p where p.auth_user_id = auth.uid() and p.is_admin)
  );

create policy "ver mis mensajes o todos si soy admin"
  on mensajes for select
  using (
    conversacion_id in (
      select c.id from conversaciones c
      join profesionales p on p.id = c.profesional_id
      where p.auth_user_id = auth.uid()
    )
    or exists (select 1 from profesionales p where p.auth_user_id = auth.uid() and p.is_admin)
  );

-- No hay policies de insert/update/delete para usuarios logueados: solo el
-- servidor (con la service_role key, que ignora RLS) puede escribir datos.
