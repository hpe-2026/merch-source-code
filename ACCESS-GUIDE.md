# NITTE Merchandise Shop — Access Guide

## How to Access

### Option 1: Public Access (No VPN/Proxy required)

You can access the Dev Cluster directly over the internet using the jump box's public IP.
Just visit these URLs in any browser (e.g., your phone):

- **Storefront:** https://frontend.117.250.206.138.nip.io
- **Admin Dashboard:** https://admin.117.250.206.138.nip.io
- **Merchant Portal:** https://merchant.117.250.206.138.nip.io

*(Note: Internal services like Keycloak, Grafana, MinIO are not exposed publicly for security. Use Option 3 to access them).*

### Option 2: Direct Access (same network as VMs)

If you're on the same network as the VMs (e.g., connected to the host machine), just open the `.201` URLs below directly in your browser.

### Option 3: Remote Access (via SSH SOCKS)

If you're remote and need access to secure internal services, run this one command to set up a SOCKS proxy:

```bash
ssh -D 9999 arcade@117.250.206.138
```
Password: *(ask the team)*

Then configure your browser:
- **Firefox**: Settings → Network Settings → Manual proxy → SOCKS Host: `localhost`, Port: `9999`, select SOCKS v5, check "Proxy DNS when using SOCKS v5" → OK
- **Chrome**: Launch with `google-chrome --proxy-server="socks5://localhost:9999"`

After that, all `.201` URLs below work directly in your browser.

---

## Application URLs (Dev Cluster)

> **Public Ingress:** NGINX Jump Box — `117.250.206.138` (routes to `192.168.56.201`)
> **Internal Ingress:** Istio ingressgateway — `192.168.56.201`

| Service | Public URL (Option 1) | Internal URL (Options 2 & 3) | Description |
|---------|-----------------------|------------------------------|-------------|
| **Storefront** | https://frontend.117.250.206.138.nip.io | http://frontend.192.168.56.201.nip.io | Customer-facing shop |
| **Admin Dashboard** | https://admin.117.250.206.138.nip.io | http://admin.192.168.56.201.nip.io | Platform admin panel |
| **Merchant Portal** | https://merchant.117.250.206.138.nip.io | http://merchant.192.168.56.201.nip.io | Merchant product management |
| **API** | https://api.117.250.206.138.nip.io/api/v1/products | http://api.192.168.56.201.nip.io/api/v1/products | Backend REST API |
| **API Docs** | https://redoc.117.250.206.138.nip.io | http://redoc.192.168.56.201.nip.io | OpenAPI documentation |
| **Keycloak** | *(Internal only)* | http://keycloak.192.168.56.201.nip.io | Identity management (dev) |
| **Jaeger** | *(Internal only)* | http://jaeger.192.168.56.201.nip.io | Distributed tracing (dev) |
| **Grafana** | *(Internal only)* | http://grafana.192.168.56.201.nip.io | Metrics dashboards (dev) |
| **Prometheus** | *(Internal only)* | http://prometheus.192.168.56.201.nip.io | Metrics query UI (dev) |
| **MinIO** | *(Internal only)* | http://minio.192.168.56.201.nip.io | Object storage console (dev) |
| **Kiali** | *(Internal only)* | http://kiali.192.168.56.201.nip.io | Istio mesh observability |

## DevOps / Admin URLs (Admin Cluster)

| Service | URL | Description |
|---------|-----|-------------|
| **Grafana** | http://grafana.192.168.56.10.nip.io | Metrics dashboards + logs |
| **Prometheus** | http://prometheus.192.168.56.10.nip.io | Metrics query UI |
| **Jenkins** | http://jenkins.192.168.56.10.nip.io | CI/CD pipeline |
| **ArgoCD** | http://argocd.192.168.56.10.nip.io | GitOps deployments |
| **Nexus** | http://nexus.192.168.56.10.nip.io | Docker image registry |
| **Keycloak (Admin)** | http://keycloak.192.168.56.10.nip.io | Identity management (admin) |
| **MinIO** | http://minio.192.168.56.10.nip.io | Object storage console |
| **Jaeger (Admin)** | http://jaeger.192.168.56.10.nip.io | Distributed tracing (admin) |
| **Thanos** | http://thanos.192.168.56.10.nip.io | Multi-cluster metrics query |
| **Alertmanager** | http://alertmanager.192.168.56.10.nip.io | Alert routing |
| **Loki** | http://loki.192.168.56.10.nip.io | Log aggregation |

---

## Login Credentials

### Application Users (for Storefront / Admin / Merchant)

| Username | Password | Role | Use for |
|----------|----------|------|---------|
| `admin@nitte.edu` | `admin@123` | Platform Admin | Admin Dashboard |
| `alumni@nitte.edu` | `alumni@123` | Alumni (verified) | Storefront shopping |
| `guest_user` | `Guest@123` | Non-alumni | Limited storefront access |
| `merchant-admin@nitte.edu` | `MerchantAdmin@123` | Merchant Admin | Merchant Portal |
| `amazon-merchant@amazon.com` | `Amazon@123` | Merchant Admin | Merchant Portal |
| `flipkart-merchant@flipkart.com` | `Flipkart@123` | Merchant Admin | Merchant Portal |
| `internal-admin@nitte.ac.in` | `InternalAdmin@123` | Internal Admin (2FA) | Full system access |
| `internal-user@nitte.ac.in` | `InternalUser@123` | Internal User | Limited DevOps access |

### DevOps Tools

| Service | Username | Password |
|---------|----------|----------|
| **Jenkins** | `local-admin` | `LocalAdmin@123` |
| **ArgoCD** | `admin` | `YWMtVgwoH92QM8uk` |
| **Nexus** | `admin` | `nexus-admin-123` |
| **Keycloak Admin Console** | `admin` | `keycloakadmin@123` |
| **Grafana** | `admin` | *(check with team — stored in admin-secrets)* |
| **MinIO** | `minioadmin` | `minio-secret-123` |

---

## SSH Access (for server administration)

```
Laptop → Jump Box → Admin Cluster / Dev Cluster

Jump Box:     ssh arcade@117.250.206.138
Admin Cluster: ssh admin          (from jump box, alias for mastervm)
Dev Cluster:   ssh worker1@192.168.56.11  (from jump box)
```

| Machine | IP | User | Role |
|---------|-----|------|------|
| Jump Box | 117.250.206.138 | arcade | Gateway to internal network |
| Admin Cluster | 192.168.56.10 | master | Jenkins, ArgoCD, Grafana, Nexus |
| Dev Cluster | 192.168.56.11 | worker1 | Application workloads |

---

## Architecture (how it all connects)

```
Developer pushes code → Jenkins builds & pushes images → ArgoCD deploys to Dev Cluster
                                                              ↓
                                                     Dev Cluster runs the app
                                                              ↓
                                              Prometheus Agent ships metrics → Admin Grafana
                                              Promtail ships logs → Admin Loki → Admin Grafana
```

---

## Quick Health Check

From the jump box (or with SOCKS proxy):

```bash
# Check API
curl -s http://api.192.168.56.200.nip.io/api/v1/health

# Check products
curl -s http://api.192.168.56.200.nip.io/api/v1/products | python3 -m json.tool | head -20

# Check frontend
curl -s -o /dev/null -w "%{http_code}" http://fron tend.192.168.56.200.nip.io
```
