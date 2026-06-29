package in.nitte.merch.keycloak;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.jboss.logging.Logger;
import org.keycloak.Config;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventListenerProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

/**
 * Factory for NitteEventListenerProvider.
 *
 * This class is registered with Java ServiceLoader via the file at:
 *   META-INF/services/org.keycloak.events.EventListenerProviderFactory
 *
 * Keycloak discovers and instantiates this factory at startup.
 * The factory is a singleton — created once, shared across all requests.
 * The provider itself (NitteEventListenerProvider) is created per-event.
 *
 * To enable this listener in a Keycloak realm:
 *   Realm settings → Events → Event listeners → add "nitte-event-listener"
 *
 * The ID "nitte-event-listener" must match the string returned by getId().
 */
public class NitteEventListenerProviderFactory implements EventListenerProviderFactory {

    private static final Logger log = Logger.getLogger(NitteEventListenerProviderFactory.class);

    /**
     * The ID used to reference this listener in Keycloak realm configuration.
     * Must be unique across all installed event listener providers.
     */
    private static final String PROVIDER_ID = "nitte-event-listener";

    /**
     * The environment variable that controls where events are sent.
     * Default: http://notification-service:9100
     * (matches the Docker Compose service name and port)
     */
    private static final String ENV_URL = "NOTIFICATION_SERVICE_URL";
    private static final String DEFAULT_URL = "http://notification-service:9100";

    // Shared ObjectMapper — thread-safe, expensive to create, reused per factory
    private ObjectMapper objectMapper;
    private String notificationServiceUrl;

    @Override
    public EventListenerProvider create(KeycloakSession session) {
        return new NitteEventListenerProvider(notificationServiceUrl, objectMapper);
    }

    @Override
    public void init(Config.Scope config) {
        this.objectMapper = new ObjectMapper();

        // Read URL from environment variable first, then from Keycloak SPI config,
        // then fall back to the default Docker Compose service name.
        String envUrl = System.getenv(ENV_URL);
        if (envUrl != null && !envUrl.isBlank()) {
            this.notificationServiceUrl = envUrl.trim();
        } else if (config.get("notificationServiceUrl") != null) {
            this.notificationServiceUrl = config.get("notificationServiceUrl");
        } else {
            this.notificationServiceUrl = DEFAULT_URL;
        }

        log.infof("NitteEventListenerProviderFactory initialized. Notification URL: %s",
                notificationServiceUrl);
    }

    @Override
    public void postInit(KeycloakSessionFactory factory) {
        // Nothing needed post-init
    }

    @Override
    public void close() {
        // Nothing to close
    }

    @Override
    public String getId() {
        return PROVIDER_ID;
    }
}
