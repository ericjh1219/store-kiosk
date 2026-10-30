-- AI 合照：互动屏拍完照后，服务器函数（supabase/functions/ai-photo）请 Gemini 把模版里的示范人物换成顾客。
-- 店主在「设置 → 合照」选风格（写实 / 卡通）和模版；平台管理员开通、设每日上限、选标准或 Pro 模型（Pro 贵一倍）
alter table public.stores
  add column ai_photo_model text not null default 'standard' check (ai_photo_model in ('standard', 'pro'));
grant select (ai_photo_model) on public.stores to authenticated;

alter table public.photos
  add column ai_status text check (ai_status in ('pending', 'done', 'failed')),
  add column ai_data text check (length(ai_data) < 6000000),   -- base64 图片（Gemini 回传 PNG，约 1MB）
  add column ai_mime text check (ai_mime in ('image/png', 'image/jpeg', 'image/webp'));

-- 每生成一张记一笔 'ai'：算每日上限，也显示在「数据」里
alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check check (type in ('visit', 'play', 'win', 'lose', 'ai'));

drop function public.admin_set_ai_photo(text, boolean, int);
create function public.admin_set_ai_photo(p_id text, p_on boolean, p_daily int, p_model text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.stores set ai_photo = p_on, ai_photo_daily = greatest(0, least(p_daily, 10000)),
    ai_photo_model = coalesce(p_model, ai_photo_model) where id = p_id;
end $$;

-- 互动屏要知道有没有开通 AI，才会在拍完照后请服务器生成
create or replace function public.kiosk_config(p_store text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'config', s.config,
    'active', s.active and (s.rental_until is null or s.rental_until >= public.store_today(s.id)),
    'ai', s.ai_photo)
  from public.stores s where s.id = p_store
$$;

-- 服务器函数调用（service_role）：检查设备密钥、是否开通、每日上限，照片标记成「生成中」
create function public.ai_photo_begin(p_store text, p_key text, p_photo uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; used int;
begin
  perform public.kiosk_check(p_store, p_key);
  select ai_photo, ai_photo_daily, ai_photo_model, config into s from public.stores where id = p_store;
  if not s.ai_photo then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  perform pg_advisory_xact_lock(hashtext('ai:' || p_store));
  -- 只能用这家店刚拍的照片，每张只生成一次
  if not exists (select 1 from public.photos where id = p_photo and store_id = p_store
                 and ai_status is null and created_at > now() - interval '2 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'photo');
  end if;
  select count(*) into used from public.events where store_id = p_store and type = 'ai'
    and created_at >= public.store_today(p_store)::timestamp at time zone public.store_tz(p_store);
  if used >= s.ai_photo_daily then return jsonb_build_object('ok', false, 'reason', 'cap'); end if;
  update public.photos set ai_status = 'pending' where id = p_photo;
  insert into public.events (store_id, type) values (p_store, 'ai');
  return jsonb_build_object('ok', true, 'model', s.ai_photo_model,
    'style', coalesce(s.config ->> 'aiStyle', 'real'), 'template', s.config ->> 'aiTemplate');
end $$;

-- 生成好了存回照片（p_data 空 = 失败，顾客就拿普通合照）
create function public.ai_photo_finish(p_photo uuid, p_data text, p_mime text) returns void
language sql security definer set search_path = '' as $$
  update public.photos set ai_status = case when p_data is null then 'failed' else 'done' end,
    ai_data = p_data, ai_mime = p_mime
  where id = p_photo and ai_status = 'pending'
$$;

-- 互动屏和顾客手机轮询 AI 合照：生成中只回状态，好了才回图片。3 分钟还没好当作失败
create function public.photo_ai(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case when ai_status = 'pending' and created_at < now() - interval '3 minutes' then 'failed' else ai_status end,
    'data', case when ai_status = 'done' then ai_data end, 'mime', ai_mime)
  from public.photos where id = p_id and created_at > now() - interval '24 hours'
$$;

create or replace function public.photo_page(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('data', p.data, 'store', s.config -> 'storeName', 'whatsapp', s.config ->> 'whatsapp',
    'ai', case when p.ai_status = 'pending' and p.created_at < now() - interval '3 minutes' then 'failed' else p.ai_status end)
  from public.photos p join public.stores s on s.id = p.store_id
  where p.id = p_id and p.created_at > now() - interval '24 hours'
$$;

-- 数据多一栏：每天生成了几张 AI 合照
drop function public.store_stats(text, int);
create function public.store_stats(p_store text, p_days int default 7) returns table (
  day date, visits bigint, plays bigint, wins bigint, loses bigint, codes bigint, redeemed bigint, ai bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := public.store_tz(p_store);
  last_day date := public.store_today(p_store);
  first_day date := last_day - (least(greatest(p_days, 1), 90) - 1);
  since timestamptz := first_day::timestamp at time zone tz;   -- 第一天的当地午夜
begin
  if not public.can_manage(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  with days as (select generate_series(first_day, last_day, '1 day')::date as d),
  ev as (
    select (e.created_at at time zone tz)::date as d,
      count(*) filter (where e.type = 'visit') as n_visit, count(*) filter (where e.type = 'play') as n_play,
      count(*) filter (where e.type = 'win') as n_win, count(*) filter (where e.type = 'lose') as n_lose,
      count(*) filter (where e.type = 'ai') as n_ai
    from public.events e where e.store_id = p_store and e.created_at >= since group by 1),
  issued as (
    select (x.created_at at time zone tz)::date as d, count(*) as n from public.redemptions x
    where x.store_id = p_store and x.created_at >= since group by 1),
  claimed as (
    select (x.redeemed_at at time zone tz)::date as d, count(*) as n from public.redemptions x
    where x.store_id = p_store and x.redeemed_at >= since group by 1)
  select days.d, coalesce(ev.n_visit, 0), coalesce(ev.n_play, 0), coalesce(ev.n_win, 0), coalesce(ev.n_lose, 0),
         coalesce(issued.n, 0), coalesce(claimed.n, 0), coalesce(ev.n_ai, 0)
  from days left join ev on ev.d = days.d left join issued on issued.d = days.d left join claimed on claimed.d = days.d
  order by days.d desc;
end $$;

revoke execute on function public.admin_set_ai_photo(text, boolean, int, text), public.ai_photo_begin(text, text, uuid),
  public.ai_photo_finish(uuid, text, text), public.photo_ai(uuid), public.store_stats(text, int)
  from public, anon, authenticated;
grant execute on function public.ai_photo_begin(text, text, uuid), public.ai_photo_finish(uuid, text, text) to service_role;
grant execute on function public.photo_ai(uuid) to anon, authenticated;
grant execute on function public.admin_set_ai_photo(text, boolean, int, text), public.store_stats(text, int) to authenticated;
