-- 修 bug：
--   1. 员工（收银）看不到设备密钥：以前员工查 stores 表就能拿到，可以自己用手机刷领奖码，被移除后还能继续用
--   2. 时区只接受正常的地名（如 Asia/Kuala_Lumpur），乱填就用马来西亚时间：以前店主改时区可以让到期的租约多用几天
--   3. 数据统计改成一次算完：以前每天每项都把整家店的记录扫一遍，记录多了会超时

-- 1. stores 表改成逐列授权读取（不含 device_key）；店主和平台管理员用 store_device_key() 取密钥
revoke select on public.stores from authenticated;
grant select (id, config, active, rental_until, created_at, updated_at, ai_photo, ai_photo_daily) on public.stores to authenticated;

create function public.store_device_key(p_store text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_manage(p_store, true) then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select device_key from public.stores where id = p_store);
end $$;

-- 2. 店铺时区：只接受地名格式，而且要是数据库认得的；否则用马来西亚时间
create function public.store_tz(p_store text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare tz text;
begin
  select config ->> 'timezone' into tz from public.stores where id = p_store;
  if tz is null or tz !~ '^[A-Za-z]+(/[A-Za-z_-]+)*$' then return 'Asia/Kuala_Lumpur'; end if;
  perform now() at time zone tz;   -- 不存在的时区会出错，跳到下面
  return tz;
exception when others then return 'Asia/Kuala_Lumpur';
end $$;

create or replace function public.store_today(p_store text) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone public.store_tz(p_store))::date
$$;

-- 3. 每日统计：只取这段日期内的记录，按天分组一次算完
create or replace function public.store_stats(p_store text, p_days int default 7) returns table (
  day date, visits bigint, plays bigint, wins bigint, loses bigint, codes bigint, redeemed bigint)
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
      count(*) filter (where e.type = 'win') as n_win, count(*) filter (where e.type = 'lose') as n_lose
    from public.events e where e.store_id = p_store and e.created_at >= since group by 1),
  issued as (
    select (x.created_at at time zone tz)::date as d, count(*) as n from public.redemptions x
    where x.store_id = p_store and x.created_at >= since group by 1),
  claimed as (
    select (x.redeemed_at at time zone tz)::date as d, count(*) as n from public.redemptions x
    where x.store_id = p_store and x.redeemed_at >= since group by 1)
  select days.d, coalesce(ev.n_visit, 0), coalesce(ev.n_play, 0), coalesce(ev.n_win, 0), coalesce(ev.n_lose, 0),
         coalesce(issued.n, 0), coalesce(claimed.n, 0)
  from days left join ev on ev.d = days.d left join issued on issued.d = days.d left join claimed on claimed.d = days.d
  order by days.d desc;
end $$;

revoke execute on function public.store_device_key(text), public.store_tz(text) from public, anon, authenticated;
grant execute on function public.store_device_key(text) to authenticated;
