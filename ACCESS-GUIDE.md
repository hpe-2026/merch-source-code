# NITTE Merchandise Shop — Access Guide

## How to Access (from any machine)

### Option 1: Direct Access (same network as VMs)

If you're on the same network as the VMs (e.g., connected to the host machine), just open the URLs below directly in your browser.

### Option 2: Remote Access (via SSH)

If you're remote, run this one command to set up a SOCKS proxy:

```bash
ssh -D 9999 arcade@117.250.206.138
```
Password: *(ask the team)*

Then configure your browser:
- **Firefox**: Settings → Network Settings → Manual proxy → SOCKS Host: `localhost`, Port: `9999`, select SOCKS v5, check "Proxy DNS when using SOCKS v5" → OK
- **Chrome**: Launch with `google-chrome --proxy-server="socks5://localhost:9999"`

After that, all URLs below work directly in your browser.

---

## Application URLs (Dev Cluster)

| Service | URL | Description |
|---------|-----|-------------|
| **Storefront** | http://frontend.192.168.56.200.nip.io | Customer-facing shop |
| **Admin Dashboard** | http://admin.192.168.56.200.nip.io | Platform admin panel |
| **Merchant Portal** | http://merchant.192.168.56.200.nip.io | Merchant product management |
| **API** | http://api.192.168.56.200.nip.io/api/v1/products | Backend REST API |
| **API Docs** | http://redoc.192.168.56.200.nip.io | OpenAPI documentation |
| **Keycloak** | http://keycloak.192.168.56.200.nip.io | Identity management (dev) |
| **Jaeger** | http://jaeger.192.168.56.200.nip.io | Distributed tracing (dev) |

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
curl -s -o /dev/null -w "%{http_code}" http://frontend.192.168.56.200.nip.io
```
