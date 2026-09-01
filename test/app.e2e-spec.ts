import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
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
