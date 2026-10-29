import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const textHeaders = {
  ...corsHeaders,
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Profile-Update-Interval": "12",
};

async function safeJson(res: Response): Promise<any> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fetchPanel(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const fallback = url.replace(/^https:\/\//, "http://");
    if (fallback !== url && /certificate|ssl|tls/i.test(String(error))) {
      return await fetch(fallback, init);
    }
    throw error;
  }
}

async function loginPanel(panelUrl: string, username: string, password: string): Promise<string | null> {
  const baseUrl = panelUrl.replace(/\/+$/, "");
  const res = await fetchPanel(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const body = await safeJson(res);
  const cookie = res.headers.get("set-cookie")?.match(/([^=]+=[^;]+)/)?.[1] || null;
  return body?.success && cookie ? cookie : null;
}

function nodeAddress(panelUrl: string): string {
  try {
    return new URL(panelUrl).hostname;
  } catch {
    return panelUrl.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  }
}

function realityValues(stream: any) {
  const reality = stream?.realitySettings || {};
  const settings = reality.settings || {};
  return {
    publicKey: settings.publicKey || reality.publicKey || "",
    fingerprint: settings.fingerprint || reality.fingerprint || "chrome",
    serverName: settings.serverName || reality.serverNames?.[0] || "",
    shortId: reality.shortIds?.[0] || reality.shortId || "",
    spiderX: settings.spiderX || reality.spiderX || "",
  };
}

function buildShareLink(protocol: string, token: string, address: string, inbound: any, client: any, name: string): string {
  let stream: any = {};
  try { stream = JSON.parse(inbound.streamSettings || "{}"); } catch {}
  const network = stream.network || "tcp";
  const security = stream.security || "none";

  if (protocol === "vmess") {
    const config: Record<string, string> = {
      v: "2", ps: name, add: address, port: String(inbound.port), id: token,
      aid: String(client?.alterId || 0), scy: client?.security || "auto",
      net: network, type: "none", host: "", path: "", tls: security === "none" ? "" : security,
    };
    if (network === "ws") {
      config.path = stream.wsSettings?.path || "";
      config.host = stream.wsSettings?.headers?.Host || "";
    }
    return `vmess://${btoa(unescape(encodeURIComponent(JSON.stringify(config))))}`;
  }

  const params = new URLSearchParams();
  params.set("type", network);
  if (protocol === "vless") params.set("encryption", client?.encryption || "none");
  if (security !== "none") {
    params.set("security", security);
    if (security === "reality") {
      const reality = realityValues(stream);
      if (reality.publicKey) params.set("pbk", reality.publicKey);
      if (reality.fingerprint) params.set("fp", reality.fingerprint);
      if (reality.serverName) params.set("sni", reality.serverName);
      if (reality.shortId) params.set("sid", reality.shortId);
      if (reality.spiderX) params.set("spx", reality.spiderX);
    } else {
      const tls = stream.tlsSettings || {};
      if (tls.serverName) params.set("sni", tls.serverName);
      if (tls.fingerprint) params.set("fp", tls.fingerprint);
      if (tls.alpn?.length) params.set("alpn", tls.alpn.join(","));
    }
  }
  if (network === "ws") {
    if (stream.wsSettings?.path) params.set("path", stream.wsSettings.path);
    if (stream.wsSettings?.headers?.Host) params.set("host", stream.wsSettings.headers.Host);
  }
  if (network === "grpc" && stream.grpcSettings?.serviceName) {
    params.set("serviceName", stream.grpcSettings.serviceName);
  }
  const password = protocol === "trojan" ? (client?.password || token) : token;
  return `${protocol}://${password}@${address}:${inbound.port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function yamlString(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function buildClashYaml(protocol: string, token: string, address: string, inbound: any, client: any, name: string): string {
  let stream: any = {};
  try { stream = JSON.parse(inbound.streamSettings || "{}"); } catch {}
  const network = stream.network || "tcp";
  const security = stream.security || "none";
  const lines = [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "proxies:",
    `  - name: ${yamlString(name)}`,
    `    type: ${protocol}`,
    `    server: ${yamlString(address)}`,
    `    port: ${Number(inbound.port)}`,
  ];
  if (protocol === "trojan") lines.push(`    password: ${yamlString(client?.password || token)}`);
  else lines.push(`    uuid: ${yamlString(token)}`);
  if (protocol === "vless") {
    lines.push("    udp: true");
    if (client?.flow) lines.push("    flow: " + yamlString(client.flow));
  }
  if (protocol === "vmess") {
    lines.push(`    alterId: ${Number(client?.alterId || 0)}`, `    cipher: ${yamlString(client?.security || "auto")}`, "    udp: true");
  }
  if (network !== "tcp") lines.push(`    network: ${network}`);
  if (security === "tls" || security === "reality") {
    lines.push("    tls: true");
    const reality = realityValues(stream);
    const sni = security === "reality" ? reality.serverName : stream.tlsSettings?.serverName;
    if (sni) lines.push(`    servername: ${yamlString(sni)}`);
    const fp = security === "reality" ? reality.fingerprint : stream.tlsSettings?.fingerprint;
    if (fp) lines.push(`    client-fingerprint: ${yamlString(fp)}`);
    if (security === "reality") {
      lines.push("    reality-opts:");
      lines.push(`      public-key: ${yamlString(reality.publicKey)}`);
      lines.push(`      short-id: ${yamlString(reality.shortId)}`);
    }
  }
  if (network === "ws") {
    lines.push("    ws-opts:");
    lines.push(`      path: ${yamlString(stream.wsSettings?.path || "/")}`);
    const host = stream.wsSettings?.headers?.Host;
    if (host) lines.push("      headers:", `        Host: ${yamlString(host)}`);
  }
  if (network === "grpc") {
    lines.push("    grpc-opts:", `      grpc-service-name: ${yamlString(stream.grpcSettings?.serviceName || "")}`);
  }
  lines.push(
    "proxy-groups:",
    "  - name: PROXY",
    "    type: select",
    `    proxies: [${yamlString(name)}, DIRECT]`,
    "rules:",
    "  - MATCH,PROXY",
    "",
  );
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const token = (url.searchParams.get("token") || "").trim();
    if (!/^[0-9a-f-]{20,}$/i.test(token)) {
      return new Response("订阅令牌无效", { status: 400, headers: { ...textHeaders, "Content-Type": "text/plain; charset=utf-8" } });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: record } = await supabase.from("client_records").select("*").eq("uuid", token).maybeSingle();
    if (!record || record.is_socks5) {
      return new Response("未找到可订阅的节点", { status: 404, headers: { ...textHeaders, "Content-Type": "text/plain; charset=utf-8" } });
    }

    // Resolve through plan -> region inbound -> panel first. This relation remains
    // stable when the administrator changes the panel/node domain.
    let panels: any[] | null = null;
    if (record.plan_id) {
      const { data: mappings } = await supabase
        .from("inbound_plans")
        .select("region_inbound_id")
        .eq("plan_id", record.plan_id);
      const mappingIds = (mappings || []).map((item: any) => item.region_inbound_id);
      if (mappingIds.length) {
        const { data: regionInbounds } = await supabase
          .from("region_inbounds")
          .select("panel_id,inbound_id")
          .in("id", mappingIds)
          .eq("inbound_id", record.inbound_id);
        const panelId = regionInbounds?.find((item: any) => item.panel_id)?.panel_id;
        if (panelId) {
          const result = await supabase
            .from("panels")
            .select("panel_url,panel_user,panel_pass,enabled")
            .eq("id", panelId)
            .eq("enabled", true)
            .limit(1);
          panels = result.data;
        }
      }
    }
    if (!panels?.length) {
      const byPreviousUrl = await supabase
        .from("panels")
        .select("panel_url,panel_user,panel_pass,enabled")
        .eq("panel_url", record.panel_url)
        .eq("enabled", true)
        .limit(1);
      panels = byPreviousUrl.data;
    }
    if (!panels?.length) {
      const fallback = await supabase.from("panels").select("panel_url,panel_user,panel_pass,enabled").eq("is_primary", true).eq("enabled", true).limit(1);
      panels = fallback.data;
    }
    const panel = panels?.[0];
    if (!panel) throw new Error("没有可用的面板配置");

    const cookie = await loginPanel(panel.panel_url, panel.panel_user, panel.panel_pass);
    if (!cookie) throw new Error("面板连接失败");
    const inboundRes = await fetchPanel(`${panel.panel_url.replace(/\/+$/, "")}/panel/api/inbounds/get/${record.inbound_id}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    const inboundBody = await safeJson(inboundRes);
    const inbound = inboundBody?.obj;
    if (!inboundBody?.success || !inbound) throw new Error("无法读取节点配置");

    const protocol = String(inbound.protocol || "").toLowerCase();
    if (!["vless", "vmess", "trojan"].includes(protocol)) {
      return new Response("该协议暂不支持订阅", { status: 400, headers: { ...textHeaders, "Content-Type": "text/plain; charset=utf-8" } });
    }
    let settings: any = {};
    try { settings = JSON.parse(inbound.settings || "{}"); } catch {}
    const client = (settings.clients || []).find((item: any) => item.id === token || item.password === token);
    if (!client) return new Response("节点已不存在或凭证已失效", { status: 404, headers: { ...textHeaders, "Content-Type": "text/plain; charset=utf-8" } });

    const address = nodeAddress(panel.panel_url);
    const name = record.client_email || record.plan_title || inbound.remark || "IP520";
    const userAgent = req.headers.get("user-agent") || "";
    const target = (url.searchParams.get("target") || "").toLowerCase();
    const wantsClash = target === "clash" || /clash|mihomo|stash/i.test(userAgent);
    const expiry = Number(client.expiryTime || 0);
    const total = Number(client.totalGB || 0);
    const subscriptionInfo = `upload=0; download=0; total=${Math.max(0, total)}; expire=${expiry > 0 ? Math.floor(expiry / 1000) : 0}`;
    const commonHeaders = { ...textHeaders, "Subscription-Userinfo": subscriptionInfo };

    if (wantsClash) {
      const yaml = buildClashYaml(protocol, token, address, inbound, client, name);
      return new Response(yaml, { headers: { ...commonHeaders, "Content-Type": "text/yaml; charset=utf-8" } });
    }
    const link = buildShareLink(protocol, token, address, inbound, client, name);
    const encoded = btoa(unescape(encodeURIComponent(`${link}\n`)));
    return new Response(encoded, { headers: { ...commonHeaders, "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    console.error("subscription error", error);
    return new Response("订阅生成失败，请稍后重试或联系客服", {
      status: 500,
      headers: { ...textHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});
