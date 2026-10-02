// Serialized transition model, not a WebSocket gateway, shell adapter, or durable ledger.
// Identity, ownership, grants, and session checks are required before these operations.
const ownsInput = (state, generation, connectionId) => state.active
  && state.generation === generation && state.connectionId === connectionId;

export function installInput(state, generation, connectionId) {
  if (!state.active || !Number.isSafeInteger(generation) || generation < 1
    || generation < state.generation) return false;
  if (generation === state.generation) return connectionId === state.connectionId;
  state.generation = generation;
  state.connectionId = connectionId;
  return true;
}

export function sendInput(state, generation, connectionId, text, write) {
  if (!ownsInput(state, generation, connectionId)) return false;
  // Raw terminal bytes do not prove whether the shell edit buffer is empty.
  state.prompt = 'unknown';
  write(text);
  return true;
}

export function claimProposal(proposal, token, now) {
  refreshProposal(proposal, now);
  if (proposal.status !== 'pending' || now >= proposal.expiresAt) return false;
  proposal.status = 'dispatching';
  proposal.deliveryToken = token;
  proposal.ackDeadlineAt = now + 5000;
  return true;
}

export function refreshProposal(proposal, now) {
  if (proposal.status === 'pending' && now >= proposal.expiresAt) proposal.status = 'expired';
  if (proposal.status === 'dispatching' && now >= proposal.ackDeadlineAt) proposal.status = 'unknown';
  return proposal.status;
}

export function deliverProposal(state, generation, connectionId, proposal, now, write) {
  const token = proposal.deliveryToken;
  const saved = state.deliveries.get(token);
  if (saved) {
    if (saved.proposalId !== proposal.id || saved.command !== proposal.command) {
      throw new Error('Delivery token reused with different input');
    }
    return { token, status: saved.status };
  }
  if (proposal.status !== 'dispatching') return { token, status: proposal.status };
  const receipt = { proposalId: proposal.id, command: proposal.command, status: 'not_sent' };
  state.deliveries.set(token, receipt);
  if (!ownsInput(state, generation, connectionId) || now >= proposal.expiresAt
    || state.prompt !== 'empty') return { token, status: receipt.status };
  // A persisted no-resend marker must precede the real PTY write. A crash here is unknown.
  receipt.status = 'unknown';
  state.prompt = 'unknown';
  try {
    if (write(proposal.command + '\n') === true) receipt.status = 'accepted';
  } catch {
    // A write failure does not prove that zero bytes reached the shell.
  }
  return { token, status: receipt.status };
}

export function recordDelivery(proposal, receipt) {
  if (proposal.deliveryToken !== receipt.token
    || !['dispatching', 'unknown'].includes(proposal.status)) return false;
  if (!['accepted', 'not_sent', 'unknown'].includes(receipt.status)) return false;
  proposal.status = receipt.status === 'not_sent' ? 'pending' : receipt.status;
  return true;
}
