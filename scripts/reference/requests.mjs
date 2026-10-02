// Admission-order model only. Request shape and canonical hashing belong to the API.
// The real adapter must read receipts consistently and commit admission conditionally.
export function admitRequest(request, receipt, validateNew) {
  if (!request.actorId) return { type: 'UNAUTHENTICATED' };
  if (request.actorId !== request.ownerId) return { type: 'NOT_FOUND' };
  if (receipt) {
    if (receipt.ownerId !== request.actorId || receipt.operation !== request.operation) {
      return { type: 'NOT_FOUND' };
    }
    return receipt.hash === request.hash
      ? { type: 'replay', result: receipt.result }
      : { type: 'IDEMPOTENCY_CONFLICT' };
  }
  return validateNew();
}
