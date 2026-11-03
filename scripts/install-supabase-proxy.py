#!/usr/bin/env python3
"""Install or repair the ip520.top same-origin Supabase proxy in Caddy.

Run this on the VPS after Kubernetes, the independent Caddy daemonset and the
website service exist. The operation is idempotent: an unchanged configuration
is not patched or restarted. Before a change, the complete ConfigMap is saved as
a timestamped backup ConfigMap.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "ops" / "caddy" / "ip520-site.caddy.template"


def run(command: list[str], *, input_text: str | None = None, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=input_text,
        text=True,
        check=True,
        capture_output=capture,
    )


def kubectl_prefix() -> list[str]:
    # RackNerd VPS uses k3s. Fall back to a regular kubectl installation when
    # this repository is migrated to another Kubernetes host.
    for command in (["k3s", "kubectl"], ["kubectl"]):
        try:
            run([*command, "version", "--client"], capture=True)
            return list(command)
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    raise RuntimeError("找不到 k3s kubectl 或 kubectl")


def locate_site_block(caddyfile: str, apex_domain: str, www_domain: str) -> tuple[int, int]:
    """Return character offsets for the existing site block, including markers."""
    begin_marker = "# BEGIN IP520 MANAGED SITE ROUTES"
    end_marker = "# END IP520 MANAGED SITE ROUTES"
    if begin_marker in caddyfile and end_marker in caddyfile:
        start = caddyfile.index(begin_marker)
        end = caddyfile.index(end_marker, start) + len(end_marker)
        if end < len(caddyfile) and caddyfile[end] == "\n":
            end += 1
        return start, end

    offset = 0
    start = -1
    for line in caddyfile.splitlines(keepends=True):
        if line.lstrip().startswith(("#", "//")):
            offset += len(line)
            continue
        if "{" in line:
            site_label = line.split("{", 1)[0]
            hosts = {
                item.strip().removeprefix("http://").removeprefix("https://").rstrip("/")
                for item in site_label.split(",")
            }
            if apex_domain in hosts or www_domain in hosts:
                start = offset
                break
        offset += len(line)
    if start < 0:
        raise RuntimeError(f"没有找到 {apex_domain}/{www_domain} 的 Caddy 站点块")

    depth = 0
    seen_open = False
    in_quote = False
    escaped = False
    for index in range(start, len(caddyfile)):
        char = caddyfile[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_quote = not in_quote
            continue
        if in_quote:
            continue
        if char == "{":
            depth += 1
            seen_open = True
        elif char == "}":
            depth -= 1
            if seen_open and depth == 0:
                end = index + 1
                if end < len(caddyfile) and caddyfile[end] == "\n":
                    end += 1
                return start, end
    raise RuntimeError("Caddy 站点块括号不完整")


def render_template(args: argparse.Namespace) -> str:
    text = TEMPLATE.read_text(encoding="utf-8").strip() + "\n"
    replacements = {
        "{{APEX_DOMAIN}}": args.apex_domain,
        "{{WWW_DOMAIN}}": args.www_domain,
        "{{SUPABASE_HOST}}": args.supabase_host,
        "{{APP_UPSTREAM}}": args.app_upstream,
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


def health_check(url: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "ip520-infrastructure-check/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = response.status
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        status = error.code
        content_type = error.headers.get("Content-Type", "")
    if status != 401 or "json" not in content_type.lower():
        raise RuntimeError(f"代理健康检查异常：HTTP {status}, Content-Type={content_type!r}")
    print(f"代理健康检查通过：{url} -> HTTP {status} JSON")


def main() -> int:
    parser = argparse.ArgumentParser(description="安装或修复 ip520.top 的 /supabase Caddy 反向代理")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--configmap", default="independent-caddy-config")
    parser.add_argument("--daemonset", default="independent-caddy")
    parser.add_argument("--apex-domain", default="ip520.top")
    parser.add_argument("--www-domain", default="www.ip520.top")
    parser.add_argument("--supabase-host", default="ltvyvkdntvgicumfzgjy.supabase.co")
    parser.add_argument("--app-upstream", default="mp-jiedianshangcheng3-0-3f1310.minipaas-apps.svc.cluster.local:80")
    parser.add_argument("--skip-health-check", action="store_true")
    args = parser.parse_args()

    kubectl = kubectl_prefix()
    raw = run(
        [*kubectl, "-n", args.namespace, "get", "configmap", args.configmap, "-o", "json"],
        capture=True,
    ).stdout
    configmap = json.loads(raw)
    current = configmap.get("data", {}).get("Caddyfile", "")
    if not current:
        raise RuntimeError(f"ConfigMap {args.configmap} 中没有 Caddyfile")

    start, end = locate_site_block(current, args.apex_domain, args.www_domain)
    managed_block = render_template(args)
    updated = current[:start] + managed_block + current[end:]

    # Validate with the exact Caddy binary running inside the daemonset.
    run(
        [*kubectl, "-n", args.namespace, "exec", "-i", f"daemonset/{args.daemonset}", "--",
         "caddy", "validate", "--config", "-", "--adapter", "caddyfile"],
        input_text=updated,
    )

    if updated == current:
        print("Caddy /supabase 路由已经是最新配置，无需修改或重启")
    else:
        timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
        backup_name = f"{args.configmap}-backup-{timestamp}"
        backup = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": backup_name, "namespace": args.namespace},
            "data": {"Caddyfile": current},
        }
        run([*kubectl, "apply", "-f", "-"], input_text=json.dumps(backup))
        run([
            *kubectl, "-n", args.namespace, "patch", "configmap", args.configmap,
            "--type", "merge", "-p", json.dumps({"data": {"Caddyfile": updated}}),
        ])
        run([*kubectl, "-n", args.namespace, "rollout", "restart", f"daemonset/{args.daemonset}"])
        run([
            *kubectl, "-n", args.namespace, "rollout", "status", f"daemonset/{args.daemonset}",
            "--timeout=120s",
        ])
        print(f"Caddy 路由更新完成；备份 ConfigMap：{backup_name}")

    if not args.skip_health_check:
        health_check(f"https://{args.www_domain}/supabase/rest/v1/")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"安装失败：{error}", file=sys.stderr)
        raise SystemExit(1)
