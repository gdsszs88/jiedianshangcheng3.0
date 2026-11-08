ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS selected_plan_id uuid REFERENCES public.plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS selected_region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL;

