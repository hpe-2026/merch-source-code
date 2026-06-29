package in.nitte.merch.keycloak;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.jboss.logging.Logger;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.events.admin.OperationType;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Keycloak EventListenerProvider implementation.
 *
 * This class is instantiated per-request by Keycloak (one instance per event).
 * It serialises the event to JSON and POSTs it to the notification-service
 * endpoint defined by the NOTIFICATION_SERVICE_URL environment variable.
 *
 * <p>Security events (login failures, password changes, etc.) and admin events
 * (user CRUD, role changes) are forwarded. Routine user events (token refresh,
 * code-to-token exchanges) are intentionally filtered to reduce noise.
 *
 * <p>Design decisions:
 * <ul>
 *   <li>Synchronous HTTP call — Keycloak event listeners run synchronously in
 *       the request thread. The notification-service should respond quickly
 *       (it just enqueues the event). The connection timeout is 3s to avoid
 *       blocking Keycloak requests if the notification-service is down.</li>
 *   <li>Fire-and-forget on failure — if the notification-service is unavailable,
 *       we log a warning but do not throw. The authentication event still
 *       completes successfully. Notifications are best-effort.</li>
 * </ul>
 */
public class NitteEventListenerProvider implements EventListenerProvider {

    private static final Logger log = Logger.getLogger(NitteEventListenerProvider.class);

    private final String notificationServiceUrl;
    private final ObjectMapper objectMapper;

    // Connection/read timeout in milliseconds.
    // Short enough to not block Keycloak request threads if notification-service is down.
    private static final int CONNECT_TIMEOUT_MS = 3000;
    private static final int READ_TIMEOUT_MS = 5000;

    public NitteEventListenerProvider(String notificationServiceUrl, ObjectMapper objectMapper) {
        this.notificationServiceUrl = notificationServiceUrl;
        this.objectMapper = objectMapper;
    }

    /**
     * Called for every user-facing event (login, logout, register, etc.)
     */
    @Override
    public void onEvent(Event event) {
        // Filter: only forward events that are security-relevant or errors.
        // Token refresh and code-to-token are high-volume routine operations —
        // forwarding them would flood the notification-service with noise.
        if (!isForwardableUserEvent(event)) {
            return;
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("eventCategory", "user");
        payload.put("eventType", event.getType() != null ? event.getType().toString() : "UNKNOWN");
        payload.put("realmId", event.getRealmId());
        payload.put("clientId", event.getClientId());
        payload.put("userId", event.getUserId());
        payload.put("sessionId", event.getSessionId());
        payload.put("ipAddress", event.getIpAddress());
        payload.put("error", event.getError());
        payload.put("details", event.getDetails());
        payload.put("time", event.getTime());

        postEvent(payload);
    }

    /**
     * Called for every admin operation (user CRUD, role assignment, client changes, etc.)
     */
    @Override
    public void onEvent(AdminEvent adminEvent, boolean includeRepresentation) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("eventCategory", "admin");
        payload.put("eventType", adminEvent.getOperationType() != null
                ? adminEvent.getOperationType().toString() : "UNKNOWN");
        payload.put("realmId", adminEvent.getRealmId());
        payload.put("resourceType", adminEvent.getResourceTypeAsString());
        payload.put("resourcePath", adminEvent.getResourcePath());
        payload.put("error", adminEvent.getError());
        payload.put("time", adminEvent.getTime());
        payload.put("authDetails", adminEvent.getAuthDetails() != null ? Map.of(
                "realmId",   adminEvent.getAuthDetails().getRealmId(),
                "clientId",  adminEvent.getAuthDetails().getClientId(),
                "userId",    adminEvent.getAuthDetails().getUserId(),
                "ipAddress", adminEvent.getAuthDetails().getIpAddress()
        ) : null);

        // Only include representation for CREATE/UPDATE to keep payload size down.
        if (includeRepresentation
                && adminEvent.getRepresentation() != null
                && (adminEvent.getOperationType() == OperationType.CREATE
                    || adminEvent.getOperationType() == OperationType.UPDATE)) {
            payload.put("representation", adminEvent.getRepresentation());
        }

        postEvent(payload);
    }

    @Override
    public void close() {
        // Nothing to close — no persistent connection.
    }

    /**
     * Returns true for user events that should be forwarded to the notification-service.
     * Filters out high-volume routine events to avoid noise.
     */
    private boolean isForwardableUserEvent(Event event) {
        if (event.getError() != null) {
            // Always forward events with errors (login failures, etc.)
            return true;
        }
        if (event.getType() == null) {
            return false;
        }
        switch (event.getType()) {
            case REGISTER:
            case REGISTER_ERROR:
            case LOGIN:
            case LOGIN_ERROR:
            case LOGOUT:
            case UPDATE_PASSWORD:
            case UPDATE_PASSWORD_ERROR:
            case UPDATE_EMAIL:
            case REMOVE_TOTP:
            case REMOVE_CREDENTIAL:
            case DELETE_ACCOUNT:
            case RESET_PASSWORD:
            case RESET_PASSWORD_ERROR:
            case SEND_VERIFY_EMAIL:
            case VERIFY_EMAIL:
            case VERIFY_EMAIL_ERROR:
                return true;
            default:
                // CODE_TO_TOKEN, TOKEN_REFRESH, etc. — skip
                return false;
        }
    }

    /**
     * Serializes the payload to JSON and POSTs it to the notification-service.
     * Failures are logged as warnings — never thrown, so Keycloak continues normally.
     */
    private void postEvent(Map<String, Object> payload) {
        if (notificationServiceUrl == null || notificationServiceUrl.isBlank()) {
            log.warn("NOTIFICATION_SERVICE_URL not set — Keycloak event not forwarded");
            return;
        }

        try {
            String json = objectMapper.writeValueAsString(payload);
            byte[] body = json.getBytes(StandardCharsets.UTF_8);

            URL url = URI.create(notificationServiceUrl + "/api/v1/events").toURL();
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("Content-Length", String.valueOf(body.length));
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setDoOutput(true);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
                os.flush();
            }

            int status = conn.getResponseCode();
            if (status >= 200 && status < 300) {
                log.debugf("Keycloak event forwarded: type=%s status=%d",
                        payload.get("eventType"), status);
            } else {
                log.warnf("Notification-service returned HTTP %d for event type=%s",
                        status, payload.get("eventType"));
            }

            conn.disconnect();
        } catch (Exception e) {
            // Log warning, never throw — authentication must not fail
            // because the notification-service is down.
            log.warnf("Failed to forward Keycloak event to notification-service: %s — %s",
                    notificationServiceUrl, e.getMessage());
        }
    }
}
