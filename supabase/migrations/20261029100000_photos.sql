-- 合照：顾客点按钮才拍，照片存在数据库 24 小时，扫码下载后自动过期删除
create table public.photos (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references public.stores(id) on delete cascade,
  data text not null check (length(data) < 1500000),   -- base64 JPEG（约 1MB 以内）
  created_at timestamptz not null default now()
);
create index photos_store_created on public.photos (store_id, created_at);
alter table public.photos enable row level security;
revoke all on public.photos from anon, authenticated;

-- 互动屏上传照片：要设备密钥，店铺可关闭，同店 5 秒内只能一张；顺便清掉过期照片
create function public.kiosk_photo(p_store text, p_key text, p_data text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  perform public.kiosk_check(p_store, p_key);
  if (select config ->> 'photo' from public.stores where id = p_store) = 'false' then
    raise exception 'photo disabled';
  end if;
  if p_data !~ '^/9j/' then raise exception 'not a jpeg'; end if;   -- JPEG 的 base64 开头
  perform pg_advisory_xact_lock(hashtext('photo:' || p_store));
  if exists (select 1 from public.photos where store_id = p_store and created_at > now() - interval '5 seconds') then
    raise exception 'too many requests';
  end if;
  delete from public.photos where created_at < now() - interval '24 hours';
  insert into public.photos (store_id, data) values (p_store, p_data) returning id into new_id;
  return new_id;
end $$;

-- 顾客扫码取照片：只要知道随机 id，24 小时内有效
create function public.get_photo(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select data from public.photos where id = p_id and created_at > now() - interval '24 hours'
$$;

revoke execute on function public.kiosk_photo(text, text, text), public.get_photo(uuid) from public, anon, authenticated;
grant execute on function public.kiosk_photo(text, text, text), public.get_photo(uuid) to anon, authenticated;
