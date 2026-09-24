# ADR 002: Transactional local persistence

Status: selected for the first local Challenge slice.

The local prototype must preserve progress after restart and reject duplicate or
competing writes. Use SQLite through `better-sqlite3`, with WAL, full synchronous
commits, foreign keys, and immediate write transactions. The adapter is behind
`SessionRepository`. No database service or Docker installation is required.

State, bounded event batches, immutable events, current observations, checkpoints,
and receipts commit together. Every write checks ownership and request identity
before checking the expected version. A failed receipt insert rolls back the
whole operation. Separate database connections share this transaction discipline.
Content hashes reject changes to a pinned version in an existing database.

Local accounts use signed, HTTP-only cookies. The server supplies account identity
and access grants. Mutations require a custom client header and an allowed browser
origin. This is a localhost development identity adapter, not public account
authentication. The entry point binds to `127.0.0.1` and rejects production mode.

DynamoDB remains the AWS proposal. Its adapter must pass the same ownership, retry,
version and atomicity tests before use. SQLite throughput does not establish AWS
capacity. The chosen synchronous adapter is suitable for short local transactions.
Large queries or high write volume require separate measurement.

References checked during implementation:

- [better-sqlite3 documentation](https://github.com/WiseLibs/better-sqlite3)
- [Fastify server configuration](https://fastify.dev/docs/latest/Reference/Server/)
