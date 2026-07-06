# Keycloak Configuration

This directory contains the Keycloak realm configuration for the NITTE Merchandise Shop.

## Files

| File | Purpose |
|------|---------|
| `nitte-realm.json` | Full realm export — auto-imported on first boot |
| `keycloak-bootstrap.sh` | Post-start script to set master realm theme + TOTP on admin |
| `themes/nitte/` | Custom login theme (login page, OTP page, CSS) |

## How It Works

`docker-compose.yml` is configured to:
1. Mount `nitte-realm.json` into Keycloak's import directory
2. Run with `--import-realm` flag
3. Mount the custom `nitte` theme

On first start (or after `docker compose down -v`), Keycloak imports the realm
automatically. No manual setup needed.

## Pre-configured Realm: `nitte-realm`

### Client: `nitte-client`
- Confidential (client secret: `nitte-client-secret`)
- Standard flow + Direct access grants + Service accounts enabled
- Redirect URIs: `*`
- Protocol mappers: realm roles, client roles, username, merchantId attribute

### Roles
| Role | Description |
|------|-------------|
| `platform-admin` | Full system access |
| `admin-internal` | Internal DevOps admin (2FA required) |
| `alumni-verified` | Verified alumni with purchasing access |
| `merchant-admin` | Merchant administrator |
| `merchant-staff` | Merchant staff (limited) |
| `non_alumni` | Non-alumni user (limited access) |
| `mongo_writer` | Internal service role for MongoDB writes |
| `internal-user` | Internal NITTE staff |

### Test Users
| Username | Password | Role |
|----------|----------|------|
| `admin@nitte.edu` | `admin@123` | platform-admin |
| `alumni@nitte.edu` | `alumni@123` | alumni-verified |
| `guest_user` | `Guest@123` | non_alumni |
| `internal-admin@nitte.ac.in` | `InternalAdmin@123` | admin-internal |
| `amazon-merchant@amazon.com` | `Amazon@123` | merchant-admin |
| `flipkart-merchant@flipkart.com` | `Flipkart@123` | merchant-admin |
| `merchant-admin@nitte.edu` | `MerchantAdmin@123` | merchant-admin |

### Service Accounts
- `service-account-nitte-client` — realm role `mongo_writer`, manages users
- `service-account-nexus-client` — view realm/clients/users

## Re-importing the Realm

The import only triggers when the realm doesn't exist in the database.
To force re-import:

```bash
docker compose down -v   # wipes keycloak-data volume
docker compose up -d keycloak
```

## Keycloak Event Listener (optional)

The `keycloak-event-listener/` project in the repo root is an SPI plugin that
forwards security events to the notification-service. It requires:
- JDK 17/21 + Maven to build
- The JAR mounted into `/opt/keycloak/providers/`

Not needed for basic operation — only for security event forwarding.
