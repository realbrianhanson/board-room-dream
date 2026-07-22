UPDATE public.model_registry
SET model_id = 'google/gemini-3.1-pro-preview',
    display_name = 'The Chair · Gemini 3 Pro',
    fallback_model_id = 'anthropic/claude-fable-5',
    enabled = true
WHERE seat = 'chair';