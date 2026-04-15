
ALTER TABLE public.region_inbounds
  ADD COLUMN max_clients integer NOT NULL DEFAULT 0,
  ADD COLUMN current_clients integer NOT NULL DEFAULT 0,
  ADD COLUMN protocol text NOT NULL DEFAULT 'mixed';
