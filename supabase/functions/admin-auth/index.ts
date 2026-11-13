import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminCorsHeaders, createAdminToken, hashAdminPassword, requestIp, verifyAdminPassword, verifyAdminToken } from "../_shared/admin-security.ts";

Deno.serve(async (req) => {
  const corsHeaders = adminCorsHeaders(req);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (body.action === "login") {
      const ip = requestIp(req);
      const windowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { count: failures } = await supabase.from("admin_login_attempts").select("id", { count: "exact", head: true }).eq("ip_address", ip).eq("succeeded", false).gte("attempted_at", windowStart);
      if ((failures || 0) >= 5) return json({ error: "登录失败次数过多，请15分钟后再试" }, 429);
      const password = String(body.password || "");
      const { data, error } = await supabase.from("admin_config").select("admin_password_hash,id").limit(1).single();
      if (error || !data) return json({ error: "配置不存在" }, 400);
      const checked = await verifyAdminPassword(password, data.admin_password_hash || "");
      await supabase.from("admin_login_attempts").insert({ ip_address: ip, succeeded: checked.valid });
      if (!checked.valid) return json({ error: "密码错误" }, 401);
      if (checked.needsUpgrade) await supabase.from("admin_config").update({ admin_password_hash: await hashAdminPassword(password) }).eq("id", data.id);
      await supabase.from("admin_login_attempts").delete().eq("ip_address", ip).eq("succeeded", false);
      return json({ token: await createAdminToken(data.id), expiresIn: 7200 });
    }
    if (body.action === "change-password") {
      const configId = await verifyAdminToken(body.token);
      if (!configId) return json({ error: "登录已失效，请重新登录" }, 401);
      const oldPassword = String(body.oldPassword || "");
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 10) return json({ error: "新密码不能少于10位" }, 400);
      const { data, error } = await supabase.from("admin_config").select("admin_password_hash").eq("id", configId).single();
      if (error || !data) return json({ error: "配置不存在" }, 400);
      if (!(await verifyAdminPassword(oldPassword, data.admin_password_hash || "")).valid) return json({ error: "旧密码错误" }, 401);
      const { error: updateError } = await supabase.from("admin_config").update({ admin_password_hash: await hashAdminPassword(newPassword) }).eq("id", configId);
      if (updateError) return json({ error: "密码更新失败" }, 500);
      return json({ success: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("admin-auth error", error);
    return json({ error: "服务器内部错误" }, 500);
  }
});
