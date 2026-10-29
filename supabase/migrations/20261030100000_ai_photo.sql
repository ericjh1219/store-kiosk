-- AI 卡通合照（加购配套）：只有平台管理员可以开通，并设每日上限控制费用；商家只能看到状态，自己改不了
-- （商家只有 config / updated_at 两栏的修改权限，见 20261029000000_kiosk.sql）
alter table public.stores
  add column ai_photo boolean not null default false,
  add column ai_photo_daily int not null default 100 check (ai_photo_daily between 0 and 10000);

create function public.admin_set_ai_photo(p_id text, p_on boolean, p_daily int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.stores set ai_photo = p_on, ai_photo_daily = greatest(0, least(p_daily, 10000)) where id = p_id;
end $$;

revoke execute on function public.admin_set_ai_photo(text, boolean, int) from public, anon, authenticated;
grant execute on function public.admin_set_ai_photo(text, boolean, int) to authenticated;
