// Fixed checkout contract with injected transport, not a running monitor.
// The adapter must enforce timeouts, no redirects, and byte bounds while reading.
const maxBytes = 65536;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

function readOrder(response, expectedStatus, reference) {
  if (
    !response ||
    response.status !== expectedStatus ||
    response.redirected ||
    typeof response.body !== 'string' ||
    Buffer.byteLength(response.body) > maxBytes
  )
    return null;
  const value = JSON.parse(response.body);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.id !== 'string' ||
    !identifier.test(value.id) ||
    value.reference !== reference ||
    value.status !== 'confirmed'
  )
    return null;
  return value;
}

export async function checkCheckout(check, reference, request) {
  try {
    const options = { redirect: 'error', timeoutMs: check.timeoutMs, maxBytes };
    const created = readOrder(
      await request({ ...options, method: 'POST', url: check.baseUrl + '/api/checkout', json: { reference } }),
      201,
      reference,
    );
    if (!created) return false;
    const stored = readOrder(
      await request({ ...options, method: 'GET', url: check.baseUrl + '/api/orders/' + created.id }),
      200,
      reference,
    );
    return stored !== null && stored.id === created.id;
  } catch {
    return false;
  }
}
