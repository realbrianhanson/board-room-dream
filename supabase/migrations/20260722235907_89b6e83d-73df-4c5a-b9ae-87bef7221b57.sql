INSERT INTO public.app_settings (key, value, version, updated_at)
VALUES (
  'allowed_oauth_origins',
  jsonb_build_object('origins', jsonb_build_array(
    'https://board-room-dream.lovable.app',
    'https://id-preview--887503f1-4c18-4b48-87f8-05674e6d8964.lovable.app',
    'https://appblueprint.com',
    'https://www.appblueprint.com'
  )),
  1,
  now()
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    version = public.app_settings.version + 1,
    updated_at = now();