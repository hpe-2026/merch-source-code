# Keycloak Configuration

This directory contains Keycloak realm configuration for local development.

## Current State

`nitte-realm.json` does not exist yet. You must either:
1. Recover it from the original repository, OR
2. Configure the realm manually and export it (instructions below)

## First-Time Realm Setup

After running `docker compose up`, Keycloak starts with only the `master` realm.
You must create the `nitte-realm` manually:

### Step 1 — Open Keycloak Admin UI

http://localhost:8080

Login: `admin` / the value of `KEYCLOAK_ADMIN_PASSWORD` in your `.env` file (default: `admin_password`)

### Step 2 — Create the Realm

1. Click the dropdown at top-left (shows "Keycloak" or "master")
2. Click **Create realm**
3. Set Realm name: `nitte-realm`
4. Click **Create**

### Step 3 — Create the Client

1. In the `nitte-realm`, go to **Clients** → **Create client**
2. Client ID: `nitte-client`
3. Client type: `OpenID Connect`
4. Click **Next**
5. Enable **Client authentication** (makes it confidential)
6. Enable **Direct access grants** (needed for username/password login in dev)
7. Set Valid redirect URIs:
   - `http://localhost:5173/*`
   - `http://localhost:5174/*`
   - `http://localhost:5175/*`
   - `http://localhost:3000/*`
8. Set Web origins: `*` (dev only — lock this down in production)
9. Click **Save**

### Step 4 — Get the Client Secret

1. Go to **Clients** → `nitte-client` → **Credentials** tab
2. Copy the **Client secret**
3. Add it to your `.env` file:
   ```
   KEYCLOAK_CLIENT_SECRET=<the-secret-you-copied>
   ```

### Step 5 — Create Realm Roles

Go to **Realm roles** → **Create role** for each of the following:
- `alumni`
- `alumni-verified`
- `merchant`
- `merchant-admin`
- `platform-admin`
- `admin-internal`
- `internal-user`

### Step 6 — Create a Test User

1. Go to **Users** → **Create new user**
2. Set username and email (e.g. `test@nitte.ac.in`)
3. Go to **Credentials** tab → Set password → Disable "Temporary"
4. Go to **Role mappings** → Assign `alumni-verified`

### Step 7 — Export the Realm (save for future use)

1. Go to **Realm settings** → **Action** (top right) → **Partial export**
2. Enable: "Export clients" and "Export groups and roles"
3. Click **Export**
4. Save the downloaded file as `keycloak/nitte-realm.json`

### Step 8 — Enable Automated Import

Once `nitte-realm.json` exists, edit `docker-compose.yml`:

1. Uncomment the volume mount in the keycloak service:
   ```yaml
   - ./keycloak/nitte-realm.json:/opt/keycloak/data/import/nitte-realm.json:ro
   ```

2. Change the command to include `--import-realm`:
   ```yaml
   command: >
     start-dev
     --import-realm
   ```

3. Run `docker compose down -v && docker compose up` to start fresh with the imported realm.

**Important:** `--import-realm` only imports if the realm does not already exist in the database.
So `docker compose down -v` (which wipes the keycloak-data volume) is needed to re-trigger import.

---

## Keycloak Event Listener SPI (keycloak-event-listener)

The `keycloak-event-listener/` Java project (in the source repository root) is a
Keycloak Server Provider Interface plugin. When built, it produces a JAR that
Keycloak loads at startup. It forwards security events (login failures, password
changes, registrations) to the notification-service via HTTP POST.

**It is not required for Keycloak to start or for authentication to work.**
It is an optional enhancement for security event forwarding.

### How to Build the Event Listener JAR

#### Prerequisites
- JDK 17 or 21 (not JDK 25 — Keycloak 24 was built against JDK 21)
- Maven 3.8+

#### Install Maven (Ubuntu/Debian)
```bash
sudo apt-get update
sudo apt-get install -y maven
```

Verify: `mvn --version`

#### Build
```bash
cd keycloak-event-listener
mvn clean package -DskipTests
```

The JAR will be at:
```
keycloak-event-listener/target/keycloak-event-listener-1.0.0.jar
```

Verify it is a real JAR (not a directory):
```bash
file keycloak-event-listener/target/keycloak-event-listener-1.0.0.jar
# Expected: Java archive data (JAR)

jar tf keycloak-event-listener/target/keycloak-event-listener-1.0.0.jar | head -10
# Expected: META-INF/MANIFEST.MF  and class files
```

#### Enable in Docker Compose

Once the JAR exists, add to the keycloak service volumes:
```yaml
- ./keycloak-event-listener/target/keycloak-event-listener-1.0.0.jar:/opt/keycloak/providers/keycloak-event-listener-1.0.0.jar:ro
```

Keycloak automatically scans `/opt/keycloak/providers/` at startup and loads any JARs it finds there.
The SPI implementation is picked up via Java ServiceLoader using the file at:
`META-INF/services/org.keycloak.events.EventListenerProviderFactory`

#### Configure in Keycloak UI (after adding the JAR)

1. Restart Keycloak with the JAR mounted
2. Go to **Realm settings** → **Events** → **Event listeners**
3. Add your custom listener ID (defined in your `EventListenerProviderFactory` implementation)
4. Save

The listener will then POST events to `http://notification-service:9100/api/v1/events`
