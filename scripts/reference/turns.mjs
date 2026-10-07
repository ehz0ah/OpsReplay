// Serial contract model of conditional transactions, not a database/provider adapter.
export function expireTurn(conversation, now) {
  const turn = conversation.turns[conversation.activeTurnId];
  if (turn?.status === 'running' && now >= turn.expiresAt) {
    turn.status = 'interrupted';
    turn.text = '';
    turn.proposals = [];
    conversation.activeTurnId = null;
  }
}

export function admitTurn(conversation, { id, hash, workerToken }, now) {
  const existing = conversation.turns[id];
  if (existing && existing.hash !== hash) return { type: 'conflict' };
  expireTurn(conversation, now);
  if (existing) return { type: 'replay', turn: existing };
  if (conversation.activeTurnId) return { type: 'busy' };
  const turn = { id, hash, workerToken, expiresAt: now + 60_000, status: 'running', text: '', proposals: [] };
  conversation.turns[id] = turn;
  conversation.activeTurnId = id;
  return { type: 'call_provider', turn };
}

export function finishTurn(conversation, id, workerToken, result, now, proposalsAllowed) {
  expireTurn(conversation, now);
  const turn = conversation.turns[id];
  if (!turn || turn.status !== 'running' || turn.workerToken !== workerToken || conversation.activeTurnId !== id)
    return false;
  if (!['completed', 'failed'].includes(result.status)) throw new Error('Invalid terminal result');
  Object.assign(turn, {
    status: result.status,
    text: result.status === 'completed' ? result.text : '',
    proposals: result.status === 'completed' && proposalsAllowed ? result.proposals : [],
  });
  conversation.activeTurnId = null;
  return true;
}
