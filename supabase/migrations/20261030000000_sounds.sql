-- 声音：素材存储也允许上传音频（背景音乐、音效）
update storage.buckets
set allowed_mime_types = array['video/mp4', 'video/webm', 'image/gif', 'image/webp', 'image/png', 'image/jpeg',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/webm']
where id = 'assets';
