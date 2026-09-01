# BlockAsset Table Allocation API

A standalone NestJS and MongoDB API for restaurant table allocation, partial
seating, and queue management.

## Requirements

- Node.js 22+
- npm
- Docker with Docker Compose

MongoDB transactions require a replica set. The included Compose service starts
a single-node replica set suitable for local development and tests.

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d
npm run start:dev
```

The API is available at `http://localhost:3000/api/v1`. Swagger documentation is
available at `http://localhost:3000/docs`.

There is no separate seed command. The configuration endpoint creates the
restaurant configuration and generates its tables atomically.

## API

### Health

```bash
curl http://localhost:3000/api/v1/health
```

### Configure the restaurant

Creates or replaces the configuration and generates `T1` through `Tn`:

```bash
curl -X PUT http://localhost:3000/api/v1/owner/restaurant/configuration \
  -H 'Content-Type: application/json' \
  -d '{"tableCount": 3, "chairsPerTable": 4}'
```

Reconfiguration returns `409 Conflict` while any table is in use or any guests
remain queued.

### View table state

```bash
curl http://localhost:3000/api/v1/owner/restaurant/tables
```

The response includes every table in numeric order and counts for `free`,
`partial`, and `occupied` states.

### Allocate a party

```bash
curl -X POST http://localhost:3000/api/v1/customer/allocations \
  -H 'Content-Type: application/json' \
  -d '{"headcount": 7}'
```

Example partial-allocation response:

```json
{
  "partyId": "68b7...",
  "status": "partially_seated",
  "originalHeadcount": 7,
  "seatedCount": 4,
  "queuedCount": 3,
  "tables": [
    {
      "code": "T1",
      "capacity": 4,
      "seatedCount": 4,
      "status": "occupied"
    }
  ],
  "queue": {
    "queueNumber": 100,
    "headcount": 3
  }
}
```

Headcount must be a positive integer and cannot exceed the restaurant's physical
capacity (`tableCount × chairsPerTable`). Invalid input returns `400 Bad Request`.

### View the queue

```bash
curl http://localhost:3000/api/v1/customer/queue
```

Queue numbers are permanent and monotonically increasing. Positions are computed
from the currently active queue.

### Process the queue

Queue processing is an explicit staff action:

```bash
curl -X POST http://localhost:3000/api/v1/owner/queue/process
```

Example response when the oldest party can be seated only partially:

```json
{
  "outcome": "processed",
  "processedCount": 1,
  "totalSeatedNow": 4,
  "remainingQueuedParties": 2,
  "processedParties": [
    {
      "partyId": "68b7...",
      "queueNumber": 100,
      "status": "partially_seated",
      "seatedNow": 4,
      "seatedCount": 8,
      "queuedCount": 2,
      "tables": [
        {
          "code": "T1",
          "capacity": 4,
          "seatedCount": 4,
          "status": "occupied"
        }
      ]
    }
  ]
}
```

`outcome` is `queue_empty` when there are no active queue entries,
`no_capacity` when the queue exists but no table is free, and `processed` when at
least one party receives tables. The endpoint has no request body and returns
`200 OK` for all three normal outcomes. `remainingQueuedParties` describes the
transaction snapshot; a customer racing with the staff call may join immediately
after that snapshot and require another processing call.

### Release a table

```bash
curl -X PATCH http://localhost:3000/api/v1/owner/tables/T1/release
```

This frees the table, records the assignment release time, and updates the party's
seated and departed counts. Releasing an unknown table returns `404 Not Found`;
releasing an already-free table returns `409 Conflict`.

## Allocation rules

Tables are exclusive to one party even when some chairs are unused. A party may
use multiple tables.

The selector applies these priorities in order:

1. Seat the full party when combined free capacity permits it.
2. Use the fewest tables.
3. Among selections using the same number of tables, minimize unused chairs.
4. Use the lowest table numbers as a deterministic final tie-break.

The implementation uses dynamic programming over attainable capacity and table
count. The challenge specifies uniform table capacities, where the state remains
small, but the selector also remains correct for differing capacities.

Partial seating is enabled. When total free capacity is insufficient, all
available tables are assigned and the remainder receives one queue number.

Strict FIFO applies once an active queue exists. A newly arriving customer joins
the queue without claiming a free table, even when capacity is currently
available. This prevents bypassing older parties but can intentionally leave
tables idle until staff calls the queue-processing endpoint.

## Queue and release policy

Releasing a table does **not** automatically process the queue. It makes the table
available for the separate `POST /api/v1/owner/queue/process` staff action and is
reported as `queueReprocessed: false` by the release endpoint.

For a party using multiple tables, releasing one table records the guests at that
table as departed. A fully served party becomes `completed` after its final table
is released. A party with unseated guests remains in the queue.

Queue processing reads active parties in ascending queue-number order. It fully
seats the oldest party when possible and then continues to the next entry while
free tables remain. If the oldest party can only be seated partially, it updates
that party and stops; no newer party is bypassed. Each processing attempt appends
assignments to the existing party while preserving its queue number and previous,
including released, assignment history.

## Concurrency approach

Allocation runs inside a MongoDB transaction:

1. Read the configuration and check for an active queue.
2. If a queue exists, persist the new party at its end without claiming a table.
3. Otherwise read free tables and compute the best table selection.
4. Conditionally update every selected table only when it is still `free` and has
   no party.
5. Atomically increment the queue counter when necessary.
6. Persist the party and its table assignments.

Any failure aborts the entire transaction. If a conditional table claim loses a
race, allocation retries from fresh database state up to three times. MongoDB's
transaction conflict handling plus the conditional filters prevent two successful
responses from assigning the same table.

Queue numbers use one atomic counter document and start at `100`.

Queue processing uses the same transaction, conditional table claims, and
three-attempt contention retry strategy. It also conditionally updates the oldest
party using its observed queue number, queued count, and status. Consequently,
simultaneous processors cannot claim the same table or subtract the same queued
guests twice. A normal allocation racing with processing either observes the
active queue and joins it or observes the post-processing table state; it cannot
take a table from an older active entry.

## MongoDB model

- `restaurantconfigs`: singleton operator configuration.
- `tables`: capacity, status, occupied seats, and current party reference.
- `parties`: original/seated/queued/departed counts plus embedded assignment
  history.
- `counters`: atomic queue-number sequence.

Assignment history is embedded because it belongs to one party and is read and
updated with that party. Current table occupancy remains a separate collection so
it can be queried and conditionally claimed efficiently.

## Tests

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

The e2e suite uses a real MongoDB replica set and defaults to the isolated
`blockasset_e2e` database. `MONGODB_TEST_URI` may override it, but as a safety
measure the selected database name must end in `_e2e`. The suite clears its
collections between tests and drops only that test database when finished.

The tests cover allocation objective ordering, exact and partial fits, validation,
queue numbering, table release, FIFO queue processing, repeated partial
processing, assignment-history preservation, bypass prevention, persistence,
simultaneous allocations, and simultaneous queue processors competing for one
table.

## Status codes

- `200 OK`: reads, configuration, table release, and queue processing.
- `201 Created`: a party allocation was persisted.
- `400 Bad Request`: malformed input or physically impossible headcount.
- `404 Not Found`: requested table does not exist.
- `409 Conflict`: unsafe reconfiguration, already-free table, missing restaurant
  configuration, or repeated allocation/queue-processing contention.

Authentication is intentionally omitted because it is outside the challenge
scope.
