# Server Infrastructure Status Report

**Date:** July 7, 2026
**Prepared by:** Kiro
**Status:** ✅ Deployed and operational — a few fixes syncing via GitOps

This document is the single source of truth for the current state of the NITTE
Merchandise Shop deployment. For URLs, credentials, and access instructions see
`ACCESS-GUIDE.md`.

---

## 1. Topology

```
Jump Box (117.250.206.138, user: arcade)
   │
   ├── Admin Cluster  192.168.56.10  (mastervm, user: admin/master)
   │      RKE2 single node. CI/CD + GitOps + Observability.
   │      Namespaces: system (Jenkins, Nexus, oauth2-proxies),
   │                  gitops-system (ArgoCD),
   │                  observability (Grafana, Prometheus, Thanos, Loki,
   │                                 Alertmanager, Jaeger),
   │                  identity-core (Keycloak SSO), storage-system (MinIO),
   │                  metallb-system.
   │
   └── Dev Cluster   192.168.56.11  (workervm1, user: worker1)
          RKE2 single node. Application workloads in namespace nitte-dev.
          MetalLB LoadBalancer IP: 192.168.56.200 (ingress controller).
          Apps reachable at *.192.168.56.200.nip.io.
```

---

## 2. What Is Running

### Dev cluster — namespace `nitte-dev`
node-backend, python-service, keycloak, MongoDB sharded cluster
(mongos + shard1 + shard2 + config + mongo-init Job), kafka, zookeeper, minio,
frontend, admin-dashboard, merchant-portal, notification-service, jaeger,
promtail, prometheus-agent.

### Admin cluster
Jenkins, Nexus, ArgoCD, Grafana, Prometheus, Thanos (Receiver/Query/Store/Compactor),
Loki, Alertmanager, Jaeger, Keycloak (admin SSO), MinIO.

### Pipelines confirmed working
- `prometheus-agent` (dev) → Thanos Receiver (admin) → Grafana. ✅
- `promtail` (dev) → Loki (admin) → Grafana. ✅

---

## 3. GitOps — `hpe-merch-config`

| ArgoCD App | Branch | Path | Target |
|------------|--------|------|--------|
| `admin-cluster-apps` | `main` | `admin-cluster/` | Admin cluster |
| `downstream-dev` | `dev` | `downstream-clusters/overlays/dev` | Dev cluster |
| `downstream-prod` | `prod` | `downstream-clusters/overlays/prod` | Prod cluster |
| `monitoring-agents-dev` | `main` | `downstream-clusters/monitoring-agents` | Dev cluster |
| `monitoring-agents-prod` | `main` | `downstream-clusters/monitoring-agents` | Prod cluster |

`admin-cluster-apps` and `downstream-dev` both run `automated.selfHeal: true`, so
Git is authoritative — manual `kubectl` edits get reverted. All fixes below were
therefore made in Git (the permanent path) rather than by patching live objects.

---

## 4. Fixes Applied (this session)

All commits authored and committed as `pall111 <pall111@users.noreply.github.com>`.

### Branch `main` (admin cluster)
1. **Prometheus ingress → direct** (`f1b3b57`): `prometheus.192.168.56.10.nip.io`
   now points straight at the `prometheus:9090` Service in `observability`,
   bypassing the disabled oauth2-proxy. Fixes the 503.
2. **ArgoCD ingress 502** (`f8452d2`, supersedes `495619c`):
   `argocd.192.168.56.10.nip.io` now uses `backend-protocol: HTTPS` to
   `argocd-server:443` **without** `ssl-passthrough`, with `ssl-redirect: false`.
   nginx terminates the browser's plain-HTTP request and re-encrypts to ArgoCD's
   built-in HTTPS. This needs **no** argocd `--insecure` flag and **no pod
   restart** — an ingress-only change. (ssl-passthrough was the cause of the 502:
   it forces the browser to speak TLS, which breaks `http://` access.)
3. **Jaeger ingress → direct** (`44ac020`): points at the `jaeger:16686` Service
   instead of the scaled-to-zero `oauth2-proxy-jaeger`.

### Branch `dev` (app workloads)
4. **Keycloak admin console infinite load** (`f8eba47`) — the root cause:
   `downstream-clusters/overlays/dev/kustomization.yaml` patched Keycloak with
   `KC_HOSTNAME_URL: http://keycloak.dev.nitte.local:8080`. That hostname is not
   resolvable from a browser (not in DNS, not reachable through the SOCKS tunnel),
   so the admin console's server-rendered `authServerUrl` pointed at a dead host
   and the SPA hung on the 3p-cookies / OIDC bootstrap. Because ArgoCD self-heals,
   any live patch was reverted back to this bad value. Changed it to the reachable
   `http://keycloak.192.168.56.200.nip.io` (no `:8080` — the ingress serves on 80).
5. **admin-dashboard `localhost:3000` CORS** — two-part fix, both now in Git:
   - Node backend `CORS_ORIGINS` now includes `http://frontend|admin|merchant.192.168.56.200.nip.io` (`de8bf2e`).
   - Frontends rebuilt by Jenkins to `55-d27081c` (`65df370`) with the runtime
     API detection in `src/config/api.js` (derives `api.<host>` from the browser
     URL; only falls back to `localhost:3000` when the host literally is
     `localhost`). The Dockerfiles no longer bake `VITE_API_URL`.

---

## 5. Remaining Manual Steps (require cluster SSH — I do not have interactive access)

These cannot be done through Git; run them from the jump box.

1. **Confirm ArgoCD synced the new ingresses.**
   ```bash
   # on admin cluster
   kubectl -n gitops-system get application admin-cluster-apps -o jsonpath='{.status.sync.status}{"\n"}'
   # if not auto-synced:
   argocd app sync admin-cluster-apps
   ```

2. **Delete any stray manually-applied Prometheus ingress in `system`.**
   A duplicate ingress claiming `prometheus.192.168.56.10.nip.io` in the `system`
   namespace triggers the nginx admission webhook "host/path conflict" and blocks
   the correct `observability` ingress. It is not in Git, so ArgoCD will not prune
   it. Medium risk (removes a route that is already broken):
   ```bash
   kubectl get ingress -A | grep prometheus
   kubectl delete ingress prometheus -n system --ignore-not-found
   ```

3. **Force ArgoCD `downstream-dev` to pull the new Keycloak env + images.**
   ```bash
   kubectl -n gitops-system get application downstream-dev -o jsonpath='{.status.sync.status}{" "}{.status.health.status}{"\n"}'
   argocd app sync downstream-dev
   kubectl -n nitte-dev rollout restart deploy/keycloak
   kubectl -n nitte-dev rollout restart deploy/admin-dashboard deploy/frontend deploy/merchant-portal
   ```

4. **Verify the admin-dashboard image actually contains the api.js fix.**
   If the dashboard still calls `localhost:3000` after the rollout, the `55-d27081c`
   build predates the fix — trigger a fresh Jenkins build (no cache) of
   admin-dashboard/frontend/merchant-portal, then let the CI image-bump commit flow
   to the `dev` branch and ArgoCD sync.

5. **Remote `nip.io` 404 vs local 200.** `frontend.192.168.56.200.nip.io` returns
   200 from within the VM network but 404 remotely via SOCKS. `nip.io` resolves the
   host to the literal `192.168.56.200`, which is only reachable through the SOCKS
   route. Ensure the browser is doing **remote DNS over SOCKS**:
   - Firefox: `network.proxy.socks_remote_dns = true` (or the "Proxy DNS when using
     SOCKS v5" checkbox).
   - Chrome: launch with `--proxy-server="socks5://localhost:9999"` (Chrome resolves
     DNS remotely for SOCKS5 by default).
   A 404 (not a connection error) means the request reached nginx but no ingress
   matched the `Host` header — usually because DNS resolved locally to something
   else, or the request hit the admin cluster (`.10`) instead of the dev LB (`.200`).

---

## 6. Quick Health Check

From the jump box or with the SOCKS proxy configured:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://api.192.168.56.200.nip.io/api/v1/health
curl -s http://api.192.168.56.200.nip.io/api/v1/products | head -c 400
curl -s -o /dev/null -w "%{http_code}\n" http://frontend.192.168.56.200.nip.io
curl -s -o /dev/null -w "%{http_code}\n" http://keycloak.192.168.56.200.nip.io/realms/master
curl -sk -o /dev/null -w "%{http_code}\n" http://argocd.192.168.56.10.nip.io
curl -s -o /dev/null -w "%{http_code}\n" http://prometheus.192.168.56.10.nip.io
```
