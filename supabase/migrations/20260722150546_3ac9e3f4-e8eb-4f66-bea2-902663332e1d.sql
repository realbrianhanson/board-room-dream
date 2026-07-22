DO $$
DECLARE
  v_cmd text;
  v_secret text;
  v_vault_present boolean;
  v_url text := 'https://raiyybdrizlmtbvehzaj.supabase.co/functions/v1/boardroom-orchestrator';
BEGIN
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'PIPELINE_SECRET')
    INTO v_vault_present;

  IF NOT v_vault_present THEN
    SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'boardroom-orchestrator-tick';
    IF v_cmd IS NULL THEN
      RAISE EXCEPTION 'boardroom-orchestrator-tick cron job not found and Vault has no PIPELINE_SECRET; refusing to proceed';
    END IF;
    v_secret := substring(v_cmd from '"x-pipeline-secret"\s*:\s*"([^"]+)"');
    IF v_secret IS NULL OR length(v_secret) = 0 THEN
      RAISE EXCEPTION 'Could not extract x-pipeline-secret from existing cron command and Vault is empty; refusing to proceed';
    END IF;
    PERFORM vault.create_secret(v_secret, 'PIPELINE_SECRET', 'Shared secret for pipeline cron -> edge function auth');
    v_secret := NULL;
  END IF;

  -- Reconfirm Vault now has the secret before touching the cron job.
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'PIPELINE_SECRET')
    INTO v_vault_present;
  IF NOT v_vault_present THEN
    RAISE EXCEPTION 'PIPELINE_SECRET still missing from Vault; leaving existing cron job intact';
  END IF;

  PERFORM cron.unschedule('boardroom-orchestrator-tick');
  PERFORM cron.schedule(
    'boardroom-orchestrator-tick',
    '* * * * *',
    format($cron$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-pipeline-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'PIPELINE_SECRET' LIMIT 1)
        ),
        body := '{}'::jsonb
      );
    $cron$, v_url)
  );
END $$;