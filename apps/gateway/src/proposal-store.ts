import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { proposalCommand, type SavedProposal } from '../../../packages/contracts/private/assistant-proposal.js';
import { isTerminalInputRecord, terminalInputKey } from '../../../packages/contracts/private/terminal-access.js';
import { isSavedProposal } from '../../../packages/contracts/private/assistant-proposal.js';
import { DynamoAttemptStore } from '../../../packages/session/src/attempt-store.js';
import type { BrowserTerminalSession } from './browser-terminal-relay.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import { retryDynamoConflict } from '../../../packages/dynamodb/src/conflict-retry.js';
export class ProposalError extends Error {
  constructor(readonly code: 'PROPOSAL_UNAVAILABLE' | 'TERMINAL_BUSY') {
    super(code);
  }
}
export interface ProposalRunner {
  run(
    session: BrowserTerminalSession,
    proposalId: string,
    signal: AbortSignal,
    queryOnly?: boolean,
  ): Promise<PublicTypes['ProposalStatus']>;
}
const key = (id: string, SK: string) => ({ PK: 'SESSION#' + id, SK });
export class DynamoProposalRunner implements ProposalRunner {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now = Date.now,
  ) {}
  private async get(id: string, SK: string, signal: AbortSignal) {
    return (
      await this.client.send(new GetCommand({ TableName: this.table, Key: key(id, SK), ConsistentRead: true }), {
        abortSignal: signal,
      })
    ).Item?.data;
  }
  async run(
    session: BrowserTerminalSession,
    proposalId: string,
    signal: AbortSignal,
    queryOnly = false,
  ): Promise<PublicTypes['ProposalStatus']> {
    const id = session.sessionId;
    const state = await new DynamoAttemptStore(this.client, this.table).session(id, signal);
    if (!state) throw new ProposalError('PROPOSAL_UNAVAILABLE');
    const input = (
      await this.client.send(
        new GetCommand({ TableName: this.table, Key: terminalInputKey(id), ConsistentRead: true }),
        { abortSignal: signal },
      )
    ).Item?.data;
    if (
      !isTerminalInputRecord(input, id) ||
      input.connectionId !== session.connectionId ||
      input.generation !== session.generation
    )
      throw new ProposalError('PROPOSAL_UNAVAILABLE');
    const raw = await this.get(id, 'PROPOSAL#' + proposalId, signal);
    if (!isSavedProposal(raw)) throw new ProposalError('PROPOSAL_UNAVAILABLE');
    const proposal = raw;
    if (
      proposal.schemaVersion !== 1 ||
      proposal.ownerId !== state.ownerId ||
      proposal.sessionId !== id ||
      proposal.view?.id !== proposalId ||
      !proposalCommand(proposal.view.command) ||
      !Number.isFinite(Date.parse(proposal.view.expiresAt))
    )
      throw new ProposalError('PROPOSAL_UNAVAILABLE');
    if (proposal.view.status === 'accepted' || proposal.view.status === 'expired') return proposal.view.status;
    if (
      proposal.view.status === 'pending' &&
      (state.view.status !== 'ready' ||
        !state.view.endsAt ||
        Date.parse(state.view.endsAt) <= this.now() ||
        Date.parse(proposal.view.expiresAt) <= this.now())
    )
      return 'expired';
    if (queryOnly && proposal.view.status === 'pending') return 'pending';
    if (!session.proposal) {
      if (proposal.view.status !== 'pending') return 'unknown';
      throw new ProposalError('TERMINAL_BUSY');
    }
    const recovering = proposal.view.status !== 'pending';
    if (recovering && !proposal.delivery) throw new ProposalError('PROPOSAL_UNAVAILABLE');
    const delivery = recovering
      ? proposal.delivery!
      : { token: randomUUID(), startedAt: new Date(this.now()).toISOString() };
    const dispatching: SavedProposal = recovering
      ? proposal
      : { ...proposal, delivery, view: { ...proposal.view, status: 'dispatching' } };
    const unchanged = (SK: string, before: unknown) => ({
      ConditionCheck: {
        TableName: this.table,
        Key: key(id, SK),
        ConditionExpression: '#d = :before',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':before': before },
      },
    });
    const write = (next: SavedProposal, before: SavedProposal) => ({
      Put: {
        TableName: this.table,
        Item: { ...key(id, 'PROPOSAL#' + proposalId), data: next },
        ConditionExpression: '#d = :before',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':before': before },
      },
    });
    try {
      if (!recovering)
        await retryDynamoConflict(
          () =>
            this.client.send(
              new TransactWriteCommand({
                ClientRequestToken: delivery.token,
                TransactItems: [
                  unchanged('STATE', state),
                  unchanged(terminalInputKey(id).SK, input),
                  write(dispatching, proposal),
                ],
              }),
              { abortSignal: signal },
            ),
          signal,
        );
    } catch {
      // An uncertain reservation must not dispatch. Read only on later confirmation.
      return 'unknown';
    }
    let result: 'accepted' | 'busy' | 'unknown' = 'unknown';
    try {
      result = await session.proposal(
        { token: delivery.token, proposalId, command: proposal.view.command, query: recovering },
        AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      );
    } catch {}
    const final: SavedProposal = {
      ...dispatching,
      view: { ...proposal.view, status: result === 'busy' ? 'pending' : result },
      delivery: result === 'busy' ? null : delivery,
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await new DynamoAttemptStore(this.client, this.table).session(id, signal);
      if (!current || current.ownerId !== proposal.ownerId) return 'unknown';
      const completionToken = randomUUID();
      try {
        await retryDynamoConflict(
          () =>
            this.client.send(
              new TransactWriteCommand({
                ClientRequestToken: completionToken,
                TransactItems: [
                  write(final, dispatching),
                  ...(result === 'accepted'
                    ? [
                        {
                          Put: {
                            TableName: this.table,
                            Item: {
                              ...key(id, 'STATE'),
                              data: {
                                ...current,
                                view: {
                                  ...current.view,
                                  assistance: {
                                    ...current.view.assistance,
                                    proposalsRun: current.view.assistance.proposalsRun + 1,
                                  },
                                },
                              },
                            },
                            ConditionExpression: '#d = :before',
                            ExpressionAttributeNames: { '#d': 'data' },
                            ExpressionAttributeValues: { ':before': current },
                          },
                        },
                      ]
                    : []),
                ],
              }),
              { abortSignal: signal },
            ),
          signal,
        );
        if (result === 'busy') throw new ProposalError('TERMINAL_BUSY');
        return final.view.status;
      } catch (error) {
        if (error instanceof ProposalError) throw error;
        const saved = await this.get(id, 'PROPOSAL#' + proposalId, signal);
        if (!isSavedProposal(saved)) return 'unknown';
        if (saved?.delivery?.token !== delivery.token || saved.view.status !== dispatching.view.status)
          return saved?.view.status === 'dispatching' ? 'unknown' : (saved?.view.status ?? 'unknown');
      }
    }
    return 'unknown';
  }
}
