import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WATCHED = [
  "面板连接检测-每5分钟",
  "超额流量强制关闭-每5分钟",
  "到期自动重置流量-每小时",
  "同步历史客户记录-每天",
  "订单自动补单-每分钟",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL") || Deno.env.get("DATABASE_URL");
  if (!databaseUrl) throw new Error("Missing DATABASE_URL secret");
  const client = new Client(databaseUrl);
  try {
    await client.connect();

    const jobsRes = await client.queryObject<{
      jobid: number; jobname: string; schedule: string; active: boolean;
    }>(
      `SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = ANY($1)`,
      [WATCHED],
    );

    const lastRunsRes = await client.queryObject<{
      jobid: number; start_time: Date; end_time: Date | null; status: string; return_message: string;
    }>(
      `SELECT DISTINCT ON (jobid) jobid, start_time, end_time, status, return_message
       FROM cron.job_run_details WHERE jobid = ANY($1)
       ORDER BY jobid, start_time DESC`,
      [jobsRes.rows.map((j) => j.jobid)],
    );
    const lastByJob = new Map<number, any>();
    for (const r of lastRunsRes.rows) lastByJob.set(r.jobid, r);

    const runningRes = await client.queryObject<{ jobid: number }>(
      `SELECT jobid FROM cron.job_run_details
       WHERE jobid = ANY($1) AND status = 'running'`,
      [jobsRes.rows.map((j) => j.jobid)],
    );
    const runningSet = new Set(runningRes.rows.map((r) => r.jobid));

    const jobs = jobsRes.rows.map((j) => {
      const last = lastByJob.get(j.jobid) || null;
      return {
        name: j.jobname,
        schedule: j.schedule,
        active: j.active,
        running: runningSet.has(j.jobid),
        lastRun: last ? last.start_time : null,
        lastEnd: last ? last.end_time : null,
        lastStatus: last ? last.status : null,
        lastMessage: last ? last.return_message : null,
      };
    });

    // History: last 20 executions from cron_execution_logs (richer than pg_cron's return_message)
    async function loadHistory(jobName: string) {
      const r = await client.queryObject<{
        created_at: Date; checked: number; reset_count: number; skipped_count: number;
        failed_count: number; trigger_source: string; details: any;
      }>(
        `SELECT created_at, checked, reset_count, skipped_count, failed_count, trigger_source, details
         FROM public.cron_execution_logs
         WHERE job_name = $1
         ORDER BY created_at DESC LIMIT 20`,
        [jobName],
      );
      return r.rows.map((x) => {
        const results = Array.isArray(x.details?.results) ? x.details.results : [];
        const oldConnectionSuspects = results.filter((item: any) => item?.stillAliveSuspect === true);
        return {
          startTime: x.created_at,
          endTime: x.created_at,
          status: "succeeded",
          checked: Number(x.checked),
          reset: Number(x.reset_count),
          skipped: Number(x.skipped_count),
          failed: Number(x.failed_count),
          source: x.trigger_source,
          oldConnectionSuspects: oldConnectionSuspects.length,
          oldConnectionRemarks: oldConnectionSuspects.slice(0, 5).map((item: any) => ({
            uuid: item?.identifier || "",
            remark: item?.remark || "",
            inboundId: item?.inboundId || null,
          })),
        };
      });
    }

    async function loadStaleTrafficGroups() {
      const r = await client.queryObject<{
        created_at: Date; details: any;
      }>(
        `SELECT created_at, details
         FROM public.cron_execution_logs
         WHERE job_name = 'enforce-disabled-quota'
         ORDER BY created_at DESC LIMIT 300`,
      );
      const groups = new Map<string, any>();
      for (const row of r.rows) {
        const results = Array.isArray(row.details?.results) ? row.details.results : [];
        for (const item of results) {
          if (item?.stillAliveSuspect !== true) continue;
          const uuid = String(item?.identifier || "");
          if (!uuid) continue;
          const previousUsed = Number(item?.previousUsed || 0);
          const used = Number(item?.used || 0);
          const increasedBytes = previousUsed > 0 && used > previousUsed ? used - previousUsed : 0;
          const current = groups.get(uuid) || {
            uuid,
            remark: item?.remark || "",
            inboundId: item?.inboundId || null,
            panel: item?.panel || "",
            firstSeen: row.created_at,
            lastSeen: row.created_at,
            count: 0,
            latestUsed: used,
            previousUsed,
            increasedBytes,
          };
          current.count += 1;
          if (new Date(row.created_at).getTime() > new Date(current.lastSeen).getTime()) {
            current.lastSeen = row.created_at;
            current.remark = item?.remark || current.remark;
            current.inboundId = item?.inboundId || current.inboundId;
            current.panel = item?.panel || current.panel;
            current.latestUsed = used;
            current.previousUsed = previousUsed;
            current.increasedBytes = increasedBytes;
          }
          if (new Date(row.created_at).getTime() < new Date(current.firstSeen).getTime()) {
            current.firstSeen = row.created_at;
          }
          groups.set(uuid, current);
        }
      }
      return [...groups.values()].sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    }
    const history = await loadHistory("auto-reset-traffic");
    const enforceQuotaHistory = await loadHistory("enforce-disabled-quota");
    const backfillHistory = await loadHistory("auto-backfill-client-records");
    const staleTrafficGroups = await loadStaleTrafficGroups();

    return new Response(
      JSON.stringify({ success: true, jobs, history, enforceQuotaHistory, staleTrafficGroups, backfillHistory, now: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    try { await client.end(); } catch {}
  }
});
