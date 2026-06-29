package in.nitte.merch.keycloak;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class NitteEventListenerProviderFactoryTest {

    @Test
    void getId_returnsExpectedId() {
        NitteEventListenerProviderFactory factory = new NitteEventListenerProviderFactory();
        assertEquals("nitte-event-listener", factory.getId());
    }
}
