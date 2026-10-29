ALTER TABLE public.admin_config
ADD COLUMN IF NOT EXISTS subscription_domain_history text[] NOT NULL DEFAULT ARRAY['dy.ip520.top']::text[];

UPDATE public.admin_config
SET subscription_domain_history = ARRAY(
  SELECT DISTINCT domain
  FROM unnest(
    coalesce(subscription_domain_history, ARRAY[]::text[]) ||
    ARRAY[coalesce(nullif(btrim(subscription_domain), ''), 'dy.ip520.top')]
  ) AS domain
  WHERE domain IS NOT NULL AND btrim(domain) <> ''
);
