-- 门店互动屏后端：店铺设置、员工权限、领奖码、互动统计
-- 安全原则：
--   * 顾客端（互动屏，anon）不能直接读写任何表，只能调用下面的 kiosk_* 函数
--   * 发奖和生成领奖码在服务器端完成，需要设备密钥（device_key），防止有人伪造领奖码
--   * 商家登录后只能看到/修改自己店铺的数据；store_id 为空的员工是平台管理员（你）

-- ========== 表 ==========
create table public.stores (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  config jsonb not null default '{}'::jsonb,
  device_key text not null default replace(gen_random_uuid()::text, '-', ''),
  active boolean not null default true,
  rental_until date,                -- 租赁到期日，过期后互动屏显示暂停服务
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff (
  id bigint generated always as identity primary key,
  email text not null check (email = lower(email)),
  store_id text references public.stores(id) on delete cascade,   -- null = 平台管理员
  role text not null default 'owner' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (email, store_id)
);

create table public.redemptions (
  code text primary key,
  store_id text not null references public.stores(id) on delete cascade,
  prize_id text,
  prize jsonb not null,             -- 发奖时的奖品快照 {name, emoji}
  is_consolation boolean not null default false,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  redeemed_by text
);
create index on public.redemptions (store_id, created_at desc);

create table public.events (
  id bigint generated always as identity primary key,
  store_id text not null references public.stores(id) on delete cascade,
  type text not null check (type in ('visit', 'play', 'win', 'lose')),
  created_at timestamptz not null default now()
);
create index on public.events (store_id, created_at);

-- ========== 权限辅助函数 ==========
create function public.my_email() returns text
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where email = public.my_email() and store_id is null)
$$;

create function public.can_manage(p_store text, p_need_owner boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_platform_admin() or exists (
    select 1 from public.staff
    where email = public.my_email() and store_id = p_store
      and (not p_need_owner or role = 'owner'))
$$;

create function public.store_today(p_store text) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce(
    (select config ->> 'timezone' from public.stores where id = p_store), 'Asia/Kuala_Lumpur'))::date
$$;

-- ========== 行级安全 ==========
alter table public.stores enable row level security;
alter table public.staff enable row level security;
alter table public.redemptions enable row level security;
alter table public.events enable row level security;

revoke all on public.stores, public.staff, public.redemptions, public.events from anon, authenticated;
grant select on public.stores, public.staff, public.redemptions, public.events to authenticated;
grant update (config, updated_at) on public.stores to authenticated;   -- 商家只能改设置，不能改到期日/启用状态
grant insert (email, store_id, role), delete on public.staff to authenticated;

create policy "manage own stores" on public.stores for select to authenticated using (public.can_manage(id));
create policy "owners edit config" on public.stores for update to authenticated
  using (public.can_manage(id, true)) with check (public.can_manage(id, true));

create policy "see staff of my stores" on public.staff for select to authenticated
  using (email = public.my_email() or public.can_manage(store_id));
create policy "owners add staff" on public.staff for insert to authenticated
  with check (case when store_id is null then public.is_platform_admin() else public.can_manage(store_id, true) end);
create policy "owners remove staff" on public.staff for delete to authenticated
  using (case when store_id is null then public.is_platform_admin() else public.can_manage(store_id, true) end
         and email <> public.my_email());

create policy "see my redemptions" on public.redemptions for select to authenticated using (public.can_manage(store_id));
create policy "see my events" on public.events for select to authenticated using (public.can_manage(store_id));

-- ========== 互动屏调用（anon） ==========
-- 读取店铺设置（设置不是秘密，不需要密钥）
create function public.kiosk_config(p_store text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'config', s.config,
    'active', s.active and (s.rental_until is null or s.rental_until >= public.store_today(s.id)))
  from public.stores s where s.id = p_store
$$;

create function public.kiosk_check(p_store text, p_key text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.stores where id = p_store and device_key = p_key and active
                 and (rental_until is null or rental_until >= public.store_today(id))) then
    raise exception 'invalid device key or store inactive' using errcode = '28000';
  end if;
end $$;

create function public.kiosk_event(p_store text, p_key text, p_type text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.kiosk_check(p_store, p_key);
  if p_type not in ('visit', 'play') then raise exception 'bad event type'; end if;
  insert into public.events (store_id, type) values (p_store, p_type);
end $$;

-- 发奖：服务器端按权重抽奖、检查每日库存、生成领奖码
create function public.kiosk_prize(p_store text, p_key text, p_won boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cfg jsonb;
  today date := public.store_today(p_store);
  pool jsonb := '[]'::jsonb;
  p jsonb;
  pid text;
  i int := 0;
  total numeric := 0;
  r numeric;
  chosen jsonb;
  chosen_id text;
  consolation boolean := false;
  new_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  perform public.kiosk_check(p_store, p_key);
  perform pg_advisory_xact_lock(hashtext('kiosk_prize:' || p_store));

  -- 防刷：同一家店 5 秒内只能发一次奖
  if exists (select 1 from public.redemptions where store_id = p_store
             and created_at > now() - interval '5 seconds') then
    raise exception 'too many requests' using errcode = '53400';
  end if;

  select config into cfg from public.stores where id = p_store;

  if p_won then
    for p in select * from jsonb_array_elements(coalesce(cfg -> 'prizes', '[]'::jsonb)) loop
      pid := coalesce(p ->> 'id', 'p' || i);
      i := i + 1;
      if coalesce((p ->> 'weight')::numeric, 0) <= 0 then continue; end if;
      if p ? 'stock' and jsonb_typeof(p -> 'stock') = 'number' and (p ->> 'stock')::int <= (
           select count(*) from public.redemptions
           where store_id = p_store and prize_id = pid
             and (created_at at time zone coalesce(cfg ->> 'timezone', 'Asia/Kuala_Lumpur'))::date = today) then
        continue;
      end if;
      pool := pool || jsonb_build_array(p || jsonb_build_object('_id', pid));
      total := total + (p ->> 'weight')::numeric;
    end loop;
  end if;

  if total > 0 then
    r := random() * total;
    for p in select * from jsonb_array_elements(pool) loop
      r := r - (p ->> 'weight')::numeric;
      chosen := p;
      exit when r < 0;
    end loop;
    chosen_id := chosen ->> '_id';
  else
    chosen := coalesce(cfg -> 'consolation', '{"name":{"zh":"谢谢参与","en":"Thanks for playing"},"emoji":"🙏"}'::jsonb);
    chosen_id := 'consolation';
    consolation := true;
  end if;

  loop
    new_code := '';
    for i in 1..6 loop
      new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    begin
      insert into public.redemptions (code, store_id, prize_id, prize, is_consolation)
      values (new_code, p_store, chosen_id,
              jsonb_build_object('name', chosen -> 'name', 'emoji', chosen -> 'emoji'), consolation);
      exit;
    exception when unique_violation then
      -- 极少数情况下码重复，换一个再试
    end;
  end loop;

  insert into public.events (store_id, type) values (p_store, case when p_won then 'win' else 'lose' end);
  return jsonb_build_object('code', new_code, 'prize', jsonb_build_object('name', chosen -> 'name', 'emoji', chosen -> 'emoji'),
                            'consolation', consolation);
end $$;

-- ========== 商家后台调用（登录后） ==========
-- 核销领奖码
create function public.redeem_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  rec public.redemptions;
  valid_days int;
begin
  select * into rec from public.redemptions where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if not public.can_manage(rec.store_id) then return jsonb_build_object('status', 'not_found'); end if;
  if rec.redeemed_at is not null then
    return jsonb_build_object('status', 'already', 'prize', rec.prize, 'created_at', rec.created_at,
                              'redeemed_at', rec.redeemed_at, 'redeemed_by', rec.redeemed_by);
  end if;
  select coalesce((config ->> 'codeValidDays')::int, 7) into valid_days from public.stores where id = rec.store_id;
  if rec.created_at < now() - make_interval(days => valid_days) then
    return jsonb_build_object('status', 'expired', 'prize', rec.prize, 'created_at', rec.created_at);
  end if;
  update public.redemptions set redeemed_at = now(), redeemed_by = public.my_email() where code = rec.code;
  return jsonb_build_object('status', 'ok', 'prize', rec.prize, 'created_at', rec.created_at);
end $$;

-- 每日统计（按店铺时区）
create function public.store_stats(p_store text, p_days int default 7) returns table (
  day date, visits bigint, plays bigint, wins bigint, loses bigint, codes bigint, redeemed bigint)
language plpgsql stable security definer set search_path = '' as $$
declare tz text;
begin
  if not public.can_manage(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(config ->> 'timezone', 'Asia/Kuala_Lumpur') into tz from public.stores where id = p_store;
  return query
  with days as (
    select generate_series(public.store_today(p_store) - (least(p_days, 90) - 1), public.store_today(p_store), '1 day')::date as d)
  select d,
    (select count(*) from public.events e where e.store_id = p_store and e.type = 'visit' and (e.created_at at time zone tz)::date = d),
    (select count(*) from public.events e where e.store_id = p_store and e.type = 'play' and (e.created_at at time zone tz)::date = d),
    (select count(*) from public.events e where e.store_id = p_store and e.type = 'win' and (e.created_at at time zone tz)::date = d),
    (select count(*) from public.events e where e.store_id = p_store and e.type = 'lose' and (e.created_at at time zone tz)::date = d),
    (select count(*) from public.redemptions x where x.store_id = p_store and (x.created_at at time zone tz)::date = d),
    (select count(*) from public.redemptions x where x.store_id = p_store and (x.redeemed_at at time zone tz)::date = d)
  from days order by d desc;
end $$;

-- 更换设备密钥（设备被偷或链接泄露时）
create function public.rotate_device_key(p_store text) returns text
language plpgsql security definer set search_path = '' as $$
declare k text := replace(gen_random_uuid()::text, '-', '');
begin
  if not public.can_manage(p_store, true) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.stores set device_key = k where id = p_store;
  return k;
end $$;

-- ========== 平台管理员（你）调用 ==========
create function public.admin_create_store(p_id text, p_config jsonb, p_owner_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.stores (id, config) values (p_id, p_config);
  if coalesce(trim(p_owner_email), '') <> '' then
    insert into public.staff (email, store_id, role) values (lower(trim(p_owner_email)), p_id, 'owner');
  end if;
end $$;

create function public.admin_set_rental(p_id text, p_active boolean, p_rental_until date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.stores set active = p_active, rental_until = p_rental_until where id = p_id;
end $$;

-- 函数权限：默认 public 可执行，收紧
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.kiosk_config(text), public.kiosk_check(text, text), public.kiosk_event(text, text, text),
  public.kiosk_prize(text, text, boolean) to anon, authenticated;
grant execute on function public.my_email(), public.is_platform_admin(), public.can_manage(text, boolean),
  public.store_today(text), public.redeem_code(text), public.store_stats(text, int),
  public.rotate_device_key(text), public.admin_create_store(text, jsonb, text),
  public.admin_set_rental(text, boolean, date) to authenticated;

-- ========== 角色素材存储 ==========
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', true, 20971520,
        array['video/mp4', 'video/webm', 'image/gif', 'image/webp', 'image/png', 'image/jpeg']);

create policy "owners upload assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and public.can_manage((storage.foldername(name))[1], true));
create policy "owners update assets" on storage.objects for update to authenticated
  using (bucket_id = 'assets' and public.can_manage((storage.foldername(name))[1], true));
create policy "owners delete assets" on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and public.can_manage((storage.foldername(name))[1], true));
