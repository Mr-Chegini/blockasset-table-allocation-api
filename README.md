# BlockAsset Table Allocation API

A standalone REST API for restaurant table allocation, partial seating, and
FIFO queue management, built with NestJS, TypeScript, and MongoDB.

## Quick start with Docker

You need only Git and Docker with Docker Compose. Node.js, npm, and MongoDB do
not need to be installed on the host.

```bash
git clone <repository-url>
cd blockasset-table-allocation-api
docker compose up --build -d
```

Compose starts a single-node MongoDB replica set, waits for it to become
healthy, and then starts the API. Check both services with:

```bash
docker compose ps
curl http://localhost:3000/api/v1/health
```

- API base URL: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/docs`
- MongoDB Compass:
  `mongodb://localhost:27017/blockasset?replicaSet=rs0&directConnection=true`

There is no separate seed command. Configure the restaurant to create its
tables and initial database records:

```bash
curl -X PUT http://localhost:3000/api/v1/owner/restaurant/configuration \
  -H 'Content-Type: application/json' \
  -d '{"tableCount":3,"chairsPerTable":4}'
```

## API reference

| Method  | Route                             | Purpose                                         |
| ------- | --------------------------------- | ----------------------------------------------- |
| `GET`   | `/health`                         | Check API availability                          |
| `PUT`   | `/owner/restaurant/configuration` | Configure the restaurant and generate `T1...Tn` |
| `GET`   | `/owner/restaurant/tables`        | View tables, occupancy, and status counts       |
| `PATCH` | `/owner/tables/:code/release`     | Release a table when its guests leave           |
| `POST`  | `/owner/queue/process`            | Allocate available tables to queued parties     |
| `PATCH` | `/owner/queue/:partyId/cancel`    | Cancel a party's remaining queued guests        |
| `POST`  | `/customer/allocations`           | Allocate tables or queue a party                |
| `GET`   | `/customer/queue`                 | View active queue positions and queue numbers   |

All routes use the `/api/v1` prefix. Example requests:

```bash
# View table state
curl http://localhost:3000/api/v1/owner/restaurant/tables

# Allocate a party
curl -X POST http://localhost:3000/api/v1/customer/allocations \
  -H 'Content-Type: application/json' \
  -d '{"headcount":7}'

# View and process the queue
curl http://localhost:3000/api/v1/customer/queue
curl -X POST http://localhost:3000/api/v1/owner/queue/process

# Release a table
curl -X PATCH http://localhost:3000/api/v1/owner/tables/T1/release

# Cancel the queued remainder of a party
curl -X PATCH \
  http://localhost:3000/api/v1/owner/queue/68b700000000000000000001/cancel
```

Swagger documents the complete request and response shapes.

## Allocation rules and design decisions

Tables are exclusive to one party, although a party may use multiple tables.
The selector applies these priorities in order:

1. Seat the full party when combined free capacity permits it.
2. Use the fewest tables.
3. For the same table count, minimize unused chairs.
4. Use the lowest table numbers as a deterministic tie-break.

The selector uses dynamic programming over attainable capacity and table count.
It supports the challenge's uniform table sizes and remains correct if table
capacities differ.

Partial seating is enabled. When free capacity cannot hold the entire party, all
available tables are assigned and the remainder joins the persisted queue. Queue
numbers start at `100`, increase monotonically, and remain stable for audit
history. Active queue positions are calculated at read time.

Strict FIFO prevents a new arrival from bypassing an existing queue. Queue
processing fully seats the oldest party when possible and continues while tables
remain. If the oldest party can only be partially seated, it updates that party
and stops without serving a newer party first.

Table release and queue cancellation do **not** automatically process the queue.
Staff must call `POST /owner/queue/process`. This keeps release behavior explicit
and avoids hiding allocation work inside another command.

Headcount must be a positive integer no greater than the restaurant's physical
capacity (`tableCount × chairsPerTable`). Invalid input returns `400`; missing
resources return `404`; state conflicts and unsafe reconfiguration return `409`.

Party counts preserve this invariant throughout allocation, processing,
cancellation, and release:

```text
originalHeadcount = seatedCount + queuedCount + departedCount + cancelledCount
```

## Concurrency approach

Allocation, queue processing, cancellation, and table release use MongoDB
transactions. Table claims are conditional on the table still being free, and
queue numbers come from one atomic counter document. If a transaction loses a
contention race, the operation reloads current state and retries up to three
times.

Queue processing also conditionally matches the observed party state before
changing its counts. These checks prevent concurrent requests from assigning the
same table, consuming the same queued guests twice, or allowing a newer party to
bypass an older one.

## MongoDB model

- `restaurantconfigs`: singleton operator configuration.
- `tables`: capacity, status, occupied seats, and current party reference.
- `parties`: party counts plus embedded assignment and release history.
- `counters`: atomic queue-number sequence.

Assignment history is embedded because it belongs to one party. Current table
occupancy remains separate so tables can be queried and claimed atomically.

## Local development and tests

For hot reload, install Node.js 22.22.3+ (or 24.15.0+) and npm. MongoDB
continues to run in Docker. If the full Docker stack is already running, stop
its API container first with `docker compose stop api` so the local process can
use port `3000`.

Set up and start the local API with:

```bash
npm ci
cp .env.example .env
docker compose up -d mongodb
npm run start:dev
```

Run the quality checks and test suites with:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

The e2e suite uses a real replica set and an isolated database whose name must
end in `_e2e`. It covers persistence, validation, exact and partial allocation,
FIFO behavior, release and cancellation, count invariants, and competing
allocation and queue-processing requests.

## Operations and scope

```bash
# Follow API logs
docker compose logs -f api

# Stop containers but preserve MongoDB data
docker compose down

# Stop containers and permanently delete local MongoDB data
docker compose down -v
```

Authentication and a frontend are intentionally omitted because they are outside
the challenge scope. The included MongoDB replica set is intended for local
development and evaluation, not production deployment.
