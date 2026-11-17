const disabled = () => ({ ok: false, enabled: false, localOnly: true, error: 'PARTNER_INTEGRATION_DISABLED' });
export async function capturePocketPartnersAuth() { return disabled(); }
export async function getPocketPartnersStatus() { return { settings: { enabled: false }, state: { connected: false, localOnly: true } }; }
export async function savePocketPartnersSettings() { return disabled(); }
export async function connectPocketPartners() { return disabled(); }
export async function disconnectPocketPartners() { return { ok: true, disconnected: true, localOnly: true }; }
export async function openPocketPartnersTrade() { return disabled(); }
