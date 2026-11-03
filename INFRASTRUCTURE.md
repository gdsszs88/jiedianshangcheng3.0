# ip520.top 基础设施恢复说明

## 为什么需要 `/supabase` 代理

生产站点的浏览器请求统一访问：

```text
https://www.ip520.top/supabase
```

VPS 上的 Caddy 会去掉 `/supabase` 前缀，再转发到：

```text
https://ltvyvkdntvgicumfzgjy.supabase.co
```

这样用户只要能打开网站，就不需要从浏览器直接连接 `*.supabase.co`。前端的同源选择逻辑位于
`src/integrations/supabase/client.ts`，Caddy 路由模板位于
`ops/caddy/ip520-site.caddy.template`。

## 新 VPS 或 Caddy 重装后的恢复步骤

前提：网站 Kubernetes Service 和 `independent-caddy` DaemonSet 已经创建。

```bash
git clone https://github.com/gdsszs88/jiedianshangcheng3.0.git
cd jiedianshangcheng3.0
python3 scripts/install-supabase-proxy.py
```

脚本会自动执行：

1. 查找 `ip520.top/www.ip520.top` 的现有 Caddy 站点块。
2. 使用当前 Caddy 容器验证新配置。
3. 将完整旧配置保存为带 UTC 时间戳的备份 ConfigMap。
4. 幂等安装 `/supabase` 路由并滚动重启 Caddy。
5. 检查 `/supabase/rest/v1/` 返回 Supabase 的 `401 JSON`，而不是网站 HTML。

重复运行脚本不会重复插入路由，也不会在配置未变化时重启 Caddy。

如果项目 ID、域名或 Kubernetes Service 名称发生变化，可覆盖默认参数：

```bash
python3 scripts/install-supabase-proxy.py \
  --apex-domain example.com \
  --www-domain www.example.com \
  --supabase-host project-ref.supabase.co \
  --app-upstream website-service.namespace.svc.cluster.local:80
```

## 手工验收

```bash
curl -i https://www.ip520.top/supabase/rest/v1/
```

未携带 API Key 时，正确结果应为 `HTTP 401` 和 JSON 错误信息。若返回网站首页 HTML，说明 Caddy 路由没有安装成功。

用户登录、管理员登录、订单查询及实时流量都依赖这条代理路由。
