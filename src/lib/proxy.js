/**
 * TRUST_PROXY = how many reverse proxies sit between the visitor and this app (Express's "trust proxy" hop
 * count). Too low and every visitor looks like the proxy's address (one shared login-lockout bucket);
 * too high and a visitor can forge their address. Anything unusable falls back to 1.
 */
function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return 1;
  const hops = Number(text);
  return hops <= 5 ? hops : 1;
}

module.exports = { parseTrustProxy };
