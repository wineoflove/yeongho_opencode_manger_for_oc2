export const MESSAGE_SEARCH_PROJECTION = `WITH text_rows AS (
  SELECT m.id message_id,m.session_id,-1 ordinal,m.type role,m.time_created created_at,json_extract(m.data,'$.text') text
  FROM session_message m
  WHERE m.type='user' AND json_type(m.data,'$.text')='text'
  UNION ALL
  SELECT m.id,m.session_id,CAST(c.key AS INTEGER),m.type,m.time_created,json_extract(c.value,'$.text')
  FROM session_message m,json_each(m.data,'$.content') c
  WHERE m.type='assistant' AND json_type(m.data,'$.content')='array'
    AND json_extract(c.value,'$.type')='text' AND json_type(c.value,'$.text')='text'
    AND NOT EXISTS(SELECT 1 FROM session_part p WHERE p.message_id=m.id)
  UNION ALL
  SELECT m.id,m.session_id,p.ordinal,m.type,m.time_created,json_extract(p.data,'$.text')
  FROM session_message m JOIN session_part p ON p.message_id=m.id
  WHERE m.type='assistant' AND json_type(m.data,'$.content')='array'
    AND p.type='text' AND json_type(p.data,'$.text')='text'
)
SELECT r.message_id || ':' || r.ordinal part_id,r.message_id,r.ordinal,r.role,r.text,r.created_at,
  s.id session_id,coalesce(s.title,'') session_title,s.directory,s.time_archived
FROM text_rows r JOIN session_v2 s ON s.id=r.session_id
WHERE s.parent_id IS NULL AND trim(r.text)<>''`
