import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import request from 'supertest';

import { AppModule } from './../src/app.module.js';

const TEST_MONGODB_URI =
  process.env.MONGODB_TEST_URI ??
  'mongodb://localhost:27017/blockasset_e2e?replicaSet=rs0&directConnection=true';

describe('Table allocation API (e2e)', () => {
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    const databaseName = new URL(TEST_MONGODB_URI).pathname.slice(1);

    if (!databaseName.endsWith('_e2e')) {
      throw new Error(
        'MONGODB_TEST_URI must target a database whose name ends with _e2e',
      );
    }

    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = TEST_MONGODB_URI;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    connection = app.get<Connection>(getConnectionToken());
  });

  beforeEach(async () => {
    await Promise.all(
      Object.values(connection.collections).map((collection) =>
        collection.deleteMany({}),
      ),
    );
  });

  it('validates configuration input and generates inspectable tables', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/owner/restaurant/configuration')
      .send({ tableCount: 0, chairsPerTable: 4 })
      .expect(400);

    await request(app.getHttpServer())
      .put('/api/v1/owner/restaurant/configuration')
      .send({ tableCount: 2, chairsPerTable: 4, unexpected: true })
      .expect(400);

    await request(app.getHttpServer())
      .put('/api/v1/owner/restaurant/configuration')
      .send({ tableCount: 2, chairsPerTable: 4 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          configuration: {
            tableCount: 2,
            chairsPerTable: 4,
            totalCapacity: 8,
          },
          generatedTables: 2,
        });
      });

    await request(app.getHttpServer())
      .get('/api/v1/owner/restaurant/tables')
      .expect(200)
      .expect(({ body }) => {
        expect(body.counts).toEqual({
          total: 2,
          free: 2,
          partial: 0,
          occupied: 0,
        });
        expect(body.tables.map(({ code }: { code: string }) => code)).toEqual([
          'T1',
          'T2',
        ]);
      });
  });

  it('persists seating, queue, and manual table-release behavior', async () => {
    await configureRestaurant(2, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 6 })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('seated');
        expect(body.seatedCount).toBe(6);
        expect(body.queuedCount).toBe(0);
        expect(body.tables).toEqual([
          {
            code: 'T1',
            capacity: 4,
            seatedCount: 4,
            status: 'occupied',
          },
          {
            code: 'T2',
            capacity: 4,
            seatedCount: 2,
            status: 'partial',
          },
        ]);
      });

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 2 })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('queued');
        expect(body.seatedCount).toBe(0);
        expect(body.queue).toEqual({ queueNumber: 100, headcount: 2 });
      });

    await request(app.getHttpServer())
      .get('/api/v1/customer/queue')
      .expect(200)
      .expect(({ body }) => {
        expect(body.count).toBe(1);
        expect(body.entries[0]).toMatchObject({
          position: 1,
          queueNumber: 100,
          headcount: 2,
        });
      });

    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          table: { code: 'T1', status: 'free', releasedSeats: 4 },
          queueReprocessed: false,
        });
      });

    await request(app.getHttpServer())
      .get('/api/v1/customer/queue')
      .expect(200)
      .expect(({ body }) => {
        expect(body.count).toBe(1);
        expect(body.entries[0].queueNumber).toBe(100);
      });
  });

  it('rejects a physically impossible party with HTTP 400', async () => {
    await configureRestaurant(2, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 9 })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('capacity of 8');
      });
  });

  it('cancels a fully queued party so a newer party can use free capacity', async () => {
    await configureRestaurant(1, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    const queuedParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 3 })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/owner/queue/${queuedParty.body.partyId}/cancel`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          partyId: queuedParty.body.partyId,
          queueNumber: 100,
          originalHeadcount: 3,
          cancelledNow: 3,
          cancelledCount: 3,
          seatedCount: 0,
          queuedCount: 0,
          departedCount: 0,
          status: 'completed',
          queueReprocessed: false,
        });
        expect(body.completedAt).toEqual(expect.any(String));
      });

    await request(app.getHttpServer())
      .get('/api/v1/customer/queue')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ count: 0, entries: [] });
      });

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 2 })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'seated',
          seatedCount: 2,
          queuedCount: 0,
          tables: [{ code: 'T1', seatedCount: 2, status: 'partial' }],
        });
      });

    const persistedParty = await connection
      .collection('parties')
      .findOne({ _id: new Types.ObjectId(queuedParty.body.partyId) });

    expect(persistedParty).toMatchObject({
      originalHeadcount: 3,
      seatedCount: 0,
      queuedCount: 0,
      departedCount: 0,
      cancelledCount: 3,
      status: 'completed',
      queueNumber: 100,
      assignments: [],
    });
    expect(
      persistedParty!.seatedCount +
        persistedParty!.queuedCount +
        persistedParty!.departedCount +
        persistedParty!.cancelledCount,
    ).toBe(persistedParty!.originalHeadcount);
  });

  it('cancels only a partially seated party remainder and preserves its table history', async () => {
    await configureRestaurant(2, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    const partialParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 6 })
      .expect(201);

    expect(partialParty.body).toMatchObject({
      status: 'partially_seated',
      seatedCount: 4,
      queuedCount: 2,
      tables: [{ code: 'T2', seatedCount: 4 }],
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/owner/queue/${partialParty.body.partyId}/cancel`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          originalHeadcount: 6,
          cancelledNow: 2,
          cancelledCount: 2,
          seatedCount: 4,
          queuedCount: 0,
          departedCount: 0,
          status: 'seated',
          completedAt: null,
        });
      });

    const persistedParty = await connection
      .collection('parties')
      .findOne({ _id: new Types.ObjectId(partialParty.body.partyId) });
    const assignedTable = await connection
      .collection('tables')
      .findOne({ code: 'T2' });

    expect(persistedParty).toMatchObject({
      originalHeadcount: 6,
      seatedCount: 4,
      queuedCount: 0,
      departedCount: 0,
      cancelledCount: 2,
      status: 'seated',
      queueNumber: 100,
    });
    expect(persistedParty?.assignments).toHaveLength(1);
    expect(persistedParty?.assignments[0]).toMatchObject({
      tableId: assignedTable?._id,
      seatedCount: 4,
      releasedAt: null,
    });
    expect(assignedTable).toMatchObject({
      code: 'T2',
      status: 'occupied',
      occupiedSeats: 4,
      partyId: persistedParty?._id,
    });
    expect(
      persistedParty!.seatedCount +
        persistedParty!.queuedCount +
        persistedParty!.departedCount +
        persistedParty!.cancelledCount,
    ).toBe(persistedParty!.originalHeadcount);
  });

  it('handles cancellation errors and permits reconfiguration once state is clear', async () => {
    await configureRestaurant(1, 4);

    const seatedParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    const queuedParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 2 })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/owner/queue/${new Types.ObjectId().toString()}/cancel`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/owner/queue/${seatedParty.body.partyId}/cancel`)
      .expect(409);
    await request(app.getHttpServer())
      .patch(`/api/v1/owner/queue/${queuedParty.body.partyId}/cancel`)
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/v1/owner/queue/${queuedParty.body.partyId}/cancel`)
      .expect(409);
    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);

    await request(app.getHttpServer())
      .put('/api/v1/owner/restaurant/configuration')
      .send({ tableCount: 2, chairsPerTable: 2 })
      .expect(200)
      .expect(({ body }) => {
        expect(body.configuration).toEqual({
          tableCount: 2,
          chairsPerTable: 2,
          totalCapacity: 4,
        });
      });
  });

  it('serializes cancellation against concurrent queue processing', async () => {
    await configureRestaurant(1, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    const queuedParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);

    const [cancellationResponse, processingResponse] = await Promise.all([
      request(app.getHttpServer()).patch(
        `/api/v1/owner/queue/${queuedParty.body.partyId}/cancel`,
      ),
      request(app.getHttpServer()).post('/api/v1/owner/queue/process'),
    ]);

    expect([200, 409]).toContain(cancellationResponse.status);
    expect(processingResponse.status).toBe(200);

    const persistedParty = await connection
      .collection('parties')
      .findOne({ _id: new Types.ObjectId(queuedParty.body.partyId) });
    const persistedTable = await connection
      .collection('tables')
      .findOne({ code: 'T1' });

    expect(persistedParty?.queuedCount).toBe(0);
    expect(
      persistedParty!.seatedCount +
        persistedParty!.queuedCount +
        persistedParty!.departedCount +
        persistedParty!.cancelledCount,
    ).toBe(persistedParty!.originalHeadcount);

    if (cancellationResponse.status === 200) {
      expect(processingResponse.body.outcome).toBe('queue_empty');
      expect(persistedParty).toMatchObject({
        seatedCount: 0,
        cancelledCount: 4,
        status: 'completed',
        assignments: [],
      });
      expect(persistedTable).toMatchObject({
        status: 'free',
        occupiedSeats: 0,
        partyId: null,
      });
    } else {
      expect(processingResponse.body.outcome).toBe('processed');
      expect(persistedParty).toMatchObject({
        seatedCount: 4,
        cancelledCount: 0,
        status: 'seated',
      });
      expect(persistedParty?.assignments).toHaveLength(1);
      expect(persistedTable).toMatchObject({
        status: 'occupied',
        occupiedSeats: 4,
        partyId: persistedParty?._id,
      });
    }
  });

  it('does not double-book a table under concurrent requests', async () => {
    await configureRestaurant(1, 4);

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/customer/allocations')
        .send({ headcount: 4 }),
      request(app.getHttpServer())
        .post('/api/v1/customer/allocations')
        .send({ headcount: 4 }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(
      responses.filter(({ body }) => body.status === 'seated'),
    ).toHaveLength(1);
    expect(
      responses.filter(({ body }) => body.status === 'queued'),
    ).toHaveLength(1);

    const seatedResponse = responses.find(
      ({ body }) => body.status === 'seated',
    );
    const queuedResponse = responses.find(
      ({ body }) => body.status === 'queued',
    );

    expect(seatedResponse?.body.tables).toHaveLength(1);
    expect(seatedResponse?.body.tables[0].code).toBe('T1');
    expect(queuedResponse?.body.tables).toEqual([]);
    expect(queuedResponse?.body.queue).toEqual({
      queueNumber: 100,
      headcount: 4,
    });

    await request(app.getHttpServer())
      .get('/api/v1/owner/restaurant/tables')
      .expect(200)
      .expect(({ body }) => {
        expect(body.counts).toEqual({
          total: 1,
          free: 0,
          partial: 0,
          occupied: 1,
        });
      });
  });

  it('prevents new arrivals from bypassing the queue and processes FIFO', async () => {
    await configureRestaurant(1, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201)
      .expect(({ body }) => {
        expect(body.queue.queueNumber).toBe(100);
      });
    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 2 })
      .expect(201)
      .expect(({ body }) => {
        expect(body.queue.queueNumber).toBe(101);
      });
    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 1 })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'queued',
          seatedCount: 0,
          queuedCount: 1,
          tables: [],
          queue: { queueNumber: 102, headcount: 1 },
        });
      });

    await request(app.getHttpServer())
      .post('/api/v1/owner/queue/process')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          outcome: 'processed',
          processedCount: 1,
          totalSeatedNow: 4,
          remainingQueuedParties: 2,
          processedParties: [
            {
              queueNumber: 100,
              status: 'seated',
              seatedNow: 4,
              seatedCount: 4,
              queuedCount: 0,
              tables: [{ code: 'T1', status: 'occupied' }],
            },
          ],
        });
      });

    await request(app.getHttpServer())
      .get('/api/v1/customer/queue')
      .expect(200)
      .expect(({ body }) => {
        expect(
          body.entries.map(
            ({ queueNumber }: { queueNumber: number }) => queueNumber,
          ),
        ).toEqual([101, 102]);
      });
  });

  it('partially processes the oldest party across attempts and preserves history', async () => {
    await configureRestaurant(3, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 8 })
      .expect(201);
    const queuedParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 10 })
      .expect(201);

    expect(queuedParty.body).toMatchObject({
      status: 'partially_seated',
      seatedCount: 4,
      queuedCount: 6,
      tables: [{ code: 'T3' }],
      queue: { queueNumber: 100, headcount: 6 },
    });

    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T3/release')
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/owner/queue/process')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          processedParties: [
            {
              queueNumber: 100,
              status: 'partially_seated',
              seatedNow: 4,
              seatedCount: 4,
              queuedCount: 2,
              tables: [{ code: 'T3' }],
            },
          ],
        });
      });

    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/owner/queue/process')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          processedCount: 1,
          remainingQueuedParties: 0,
          processedParties: [
            {
              queueNumber: 100,
              status: 'seated',
              seatedNow: 2,
              seatedCount: 6,
              queuedCount: 0,
              tables: [{ code: 'T1', status: 'partial' }],
            },
          ],
        });
      });

    const persistedParty = await connection
      .collection('parties')
      .findOne({ _id: new Types.ObjectId(queuedParty.body.partyId) });

    expect(persistedParty).toMatchObject({
      originalHeadcount: 10,
      seatedCount: 6,
      queuedCount: 0,
      departedCount: 4,
      status: 'seated',
      queueNumber: 100,
    });
    expect(persistedParty?.assignments).toHaveLength(3);
    expect(persistedParty?.assignments[0].releasedAt).toBeInstanceOf(Date);
    expect(persistedParty?.assignments[1].releasedAt).toBeNull();
    expect(persistedParty?.assignments[2].releasedAt).toBeNull();
  });

  it('allows only one simultaneous queue processor to assign a table', async () => {
    await configureRestaurant(1, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    const queuedParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);

    const responses = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/owner/queue/process'),
      request(app.getHttpServer()).post('/api/v1/owner/queue/process'),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(
      responses.filter(({ body }) => body.outcome === 'processed'),
    ).toHaveLength(1);
    expect(
      responses.filter(({ body }) => body.outcome === 'queue_empty'),
    ).toHaveLength(1);

    const persistedParty = await connection
      .collection('parties')
      .findOne({ _id: new Types.ObjectId(queuedParty.body.partyId) });
    const persistedTable = await connection
      .collection('tables')
      .findOne({ code: 'T1' });

    expect(persistedParty).toMatchObject({
      seatedCount: 4,
      queuedCount: 0,
      status: 'seated',
    });
    expect(persistedParty?.assignments).toHaveLength(1);
    expect(persistedTable).toMatchObject({
      status: 'occupied',
      occupiedSeats: 4,
      partyId: persistedParty?._id,
    });
  });

  it('keeps an arriving customer behind the oldest party during processing', async () => {
    await configureRestaurant(1, 4);

    await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    const oldestParty = await request(app.getHttpServer())
      .post('/api/v1/customer/allocations')
      .send({ headcount: 4 })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/api/v1/owner/tables/T1/release')
      .expect(200);

    const [processingResponse, arrivalResponse] = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/owner/queue/process'),
      request(app.getHttpServer())
        .post('/api/v1/customer/allocations')
        .send({ headcount: 1 }),
    ]);

    expect(processingResponse.status).toBe(200);
    expect(processingResponse.body).toMatchObject({
      outcome: 'processed',
      processedParties: [
        {
          partyId: oldestParty.body.partyId,
          queueNumber: 100,
          queuedCount: 0,
          tables: [{ code: 'T1' }],
        },
      ],
    });
    expect(arrivalResponse.status).toBe(201);
    expect(arrivalResponse.body).toMatchObject({
      status: 'queued',
      seatedCount: 0,
      queuedCount: 1,
      tables: [],
      queue: { queueNumber: 101, headcount: 1 },
    });
  });

  afterAll(async () => {
    if (connection) {
      await connection.dropDatabase();
    }

    if (app) {
      await app.close();
    }
  });

  async function configureRestaurant(
    tableCount: number,
    chairsPerTable: number,
  ) {
    await request(app.getHttpServer())
      .put('/api/v1/owner/restaurant/configuration')
      .send({ tableCount, chairsPerTable })
      .expect(200);
  }
});
