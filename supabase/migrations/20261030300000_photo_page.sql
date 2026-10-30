-- 顾客扫码打开的照片页：照片 + 店名 + 店家的 WhatsApp 社群链接（先加入社群再下载照片）
create function public.photo_page(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('data', p.data, 'store', s.config -> 'storeName', 'whatsapp', s.config ->> 'whatsapp')
  from public.photos p join public.stores s on s.id = p.store_id
  where p.id = p_id and p.created_at > now() - interval '24 hours'
$$;

revoke execute on function public.photo_page(uuid) from public, anon, authenticated;
grant execute on function public.photo_page(uuid) to anon, authenticated;
