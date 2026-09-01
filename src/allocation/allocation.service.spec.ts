import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';

import { RestaurantConfig } from '../restaurant/schemas/restaurant-config.schema.js';
import { Table, TableStatus } from '../restaurant/schemas/table.schema.js';
import { AllocationService } from './allocation.service.js';
import { Counter } from './schemas/counter.schema.js';
import { Party, PartyStatus } from './schemas/party.schema.js';

function queryResult<T>(value: T) {
  const lean = vi.fn().mockResolvedValue(value);
  const session = vi.fn().mockReturnValue({ lean });

  return { session, lean };
}

function sortedQueryResult<T>(value: T) {
  const lean = vi.fn().mockResolvedValue(value);
  const session = vi.fn().mockReturnValue({ lean });
  const sort = vi.fn().mockReturnValue({ lean, session });

  return { sort, session, lean };
}

function freeTable(tableNumber: number, capacity = 4) {
  return {
    _id: new Types.ObjectId(),
    code: `T${tableNumber}`,
    tableNumber,
    capacity,
    status: TableStatus.FREE,
    partyId: null,
    occupiedSeats: 0,
  };
}

describe('AllocationService', () => {
  const restaurantConfigModel = { findOne: vi.fn() };
  const tableModel = {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    bulkWrite: vi.fn(),
  };
  const partyModel = {
    create: vi.fn(),
    exists: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };
  const counterModel = { findOneAndUpdate: vi.fn() };
  const connection = { startSession: vi.fn() };

  let sessions: Array<{
    withTransaction: ReturnType<typeof vi.fn>;
    endSession: ReturnType<typeof vi.fn>;
  }>;
  let service: AllocationService;

  beforeEach(() => {
    vi.clearAllMocks();
    sessions = [];
    connection.startSession.mockImplementation(() => {
      const session = {
        withTransaction: vi.fn(async (work) => work()),
        endSession: vi.fn(),
      };
      sessions.push(session);
      return Promise.resolve(session);
    });
    restaurantConfigModel.findOne.mockReturnValue(
      queryResult({ tableCount: 3, chairsPerTable: 4 }),
    );
    tableModel.find.mockReturnValue(queryResult([]));
    tableModel.bulkWrite.mockResolvedValue({ matchedCount: 0 });
    tableModel.findOneAndUpdate.mockResolvedValue({});
    partyModel.create.mockResolvedValue([]);
    partyModel.exists.mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    });
    partyModel.findOneAndUpdate.mockResolvedValue({});
    counterModel.findOneAndUpdate.mockResolvedValue({ sequence: 100 });

    service = new AllocationService(
      restaurantConfigModel as unknown as Model<RestaurantConfig>,
      tableModel as unknown as Model<Table>,
      partyModel as unknown as Model<Party>,
      counterModel as unknown as Model<Counter>,
      connection as unknown as Connection,
    );
  });

  it('claims selected tables and persists a fully seated party', async () => {
    const tables = [freeTable(1), freeTable(2)];
    tableModel.find.mockReturnValue(queryResult(tables));
    tableModel.bulkWrite.mockResolvedValue({ matchedCount: 2 });

    const result = await service.allocate({ headcount: 6 });

    expect(result).toMatchObject({
      status: PartyStatus.SEATED,
      originalHeadcount: 6,
      seatedCount: 6,
      queuedCount: 0,
      tables: [
        {
          code: 'T1',
          capacity: 4,
          seatedCount: 4,
          status: TableStatus.OCCUPIED,
        },
        {
          code: 'T2',
          capacity: 4,
          seatedCount: 2,
          status: TableStatus.PARTIAL,
        },
      ],
      queue: null,
    });
    expect(tableModel.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({
              _id: tables[0]._id,
              status: TableStatus.FREE,
              partyId: null,
            }),
          }),
        }),
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({ _id: tables[1]._id }),
          }),
        }),
      ],
      { session: sessions[0] },
    );
    expect(counterModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(partyModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          originalHeadcount: 6,
          seatedCount: 6,
          queuedCount: 0,
          status: PartyStatus.SEATED,
          queueNumber: null,
          assignments: [
            expect.objectContaining({ seatedCount: 4 }),
            expect.objectContaining({ seatedCount: 2 }),
          ],
        }),
      ],
      { session: sessions[0] },
    );
  });

  it('persists a partially seated party and an atomic queue number', async () => {
    const availableTable = freeTable(1);
    tableModel.find.mockReturnValue(queryResult([availableTable]));
    tableModel.bulkWrite.mockResolvedValue({ matchedCount: 1 });
    counterModel.findOneAndUpdate.mockResolvedValue({ sequence: 104 });

    const result = await service.allocate({ headcount: 6 });

    expect(result).toMatchObject({
      status: PartyStatus.PARTIALLY_SEATED,
      seatedCount: 4,
      queuedCount: 2,
      tables: [
        {
          code: 'T1',
          seatedCount: 4,
          status: TableStatus.OCCUPIED,
        },
      ],
      queue: { queueNumber: 104, headcount: 2 },
    });
    expect(counterModel.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'queue' },
      [
        {
          $set: {
            sequence: { $add: [{ $ifNull: ['$sequence', 99] }, 1] },
          },
        },
      ],
      {
        returnDocument: 'after',
        upsert: true,
        updatePipeline: true,
        session: sessions[0],
      },
    );
  });

  it('queues the whole party when no table is free', async () => {
    const result = await service.allocate({ headcount: 3 });

    expect(result).toMatchObject({
      status: PartyStatus.QUEUED,
      seatedCount: 0,
      queuedCount: 3,
      tables: [],
      queue: { queueNumber: 100, headcount: 3 },
    });
    expect(tableModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('queues a new party without claiming free tables while a queue is active', async () => {
    partyModel.exists.mockReturnValue({
      session: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    });
    tableModel.find.mockReturnValue(queryResult([freeTable(1)]));

    const result = await service.allocate({ headcount: 3 });

    expect(result).toMatchObject({
      status: PartyStatus.QUEUED,
      seatedCount: 0,
      queuedCount: 3,
      tables: [],
      queue: { queueNumber: 100, headcount: 3 },
    });
    expect(tableModel.find).not.toHaveBeenCalled();
    expect(tableModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('rejects a party larger than the physical restaurant capacity', async () => {
    restaurantConfigModel.findOne.mockReturnValue(
      queryResult({ tableCount: 2, chairsPerTable: 4 }),
    );

    await expect(service.allocate({ headcount: 9 })).rejects.toThrow(
      BadRequestException,
    );
    expect(tableModel.find).not.toHaveBeenCalled();
    expect(partyModel.create).not.toHaveBeenCalled();
    expect(sessions[0].endSession).toHaveBeenCalledOnce();
  });

  it('rejects allocation before the restaurant is configured', async () => {
    restaurantConfigModel.findOne.mockReturnValue(queryResult(null));

    await expect(service.allocate({ headcount: 2 })).rejects.toThrow(
      ConflictException,
    );
    expect(tableModel.find).not.toHaveBeenCalled();
  });

  it('retries from fresh state when conditional table claiming loses a race', async () => {
    const availableTable = freeTable(1);
    tableModel.find.mockReturnValue(queryResult([availableTable]));
    tableModel.bulkWrite
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });

    await expect(service.allocate({ headcount: 4 })).resolves.toMatchObject({
      status: PartyStatus.SEATED,
      seatedCount: 4,
    });

    expect(connection.startSession).toHaveBeenCalledTimes(2);
    expect(tableModel.bulkWrite).toHaveBeenCalledTimes(2);
    expect(partyModel.create).toHaveBeenCalledOnce();
    expect(sessions[0].endSession).toHaveBeenCalledOnce();
    expect(sessions[1].endSession).toHaveBeenCalledOnce();
  });

  it('returns a conflict after repeated conditional-claim failures', async () => {
    tableModel.find.mockReturnValue(queryResult([freeTable(1)]));
    tableModel.bulkWrite.mockResolvedValue({ matchedCount: 0 });

    await expect(service.allocate({ headcount: 4 })).rejects.toThrow(
      ConflictException,
    );
    expect(connection.startSession).toHaveBeenCalledTimes(3);
    expect(partyModel.create).not.toHaveBeenCalled();
  });

  describe('getQueue', () => {
    it('returns active queued parties in queue-number order with positions', async () => {
      const queuedAt = new Date('2026-09-02T08:00:00.000Z');
      const parties = [
        {
          _id: new Types.ObjectId(),
          originalHeadcount: 6,
          seatedCount: 4,
          queuedCount: 2,
          queueNumber: 100,
          createdAt: queuedAt,
        },
        {
          _id: new Types.ObjectId(),
          originalHeadcount: 3,
          seatedCount: 0,
          queuedCount: 3,
          queueNumber: 101,
          createdAt: queuedAt,
        },
      ];
      const lean = vi.fn().mockResolvedValue(parties);
      const sort = vi.fn().mockReturnValue({ lean });
      partyModel.find.mockReturnValue({ sort });

      await expect(service.getQueue()).resolves.toEqual({
        count: 2,
        entries: [
          {
            position: 1,
            partyId: parties[0]._id.toString(),
            queueNumber: 100,
            headcount: 2,
            originalHeadcount: 6,
            seatedCount: 4,
            queuedAt,
          },
          {
            position: 2,
            partyId: parties[1]._id.toString(),
            queueNumber: 101,
            headcount: 3,
            originalHeadcount: 3,
            seatedCount: 0,
            queuedAt,
          },
        ],
      });
      expect(sort).toHaveBeenCalledWith({ queueNumber: 1 });
    });
  });

  describe('processQueue', () => {
    it('returns an empty outcome when there is no active queue', async () => {
      partyModel.find.mockReturnValue(sortedQueryResult([]));

      await expect(service.processQueue()).resolves.toEqual({
        outcome: 'queue_empty',
        processedCount: 0,
        totalSeatedNow: 0,
        remainingQueuedParties: 0,
        processedParties: [],
      });
      expect(tableModel.find).not.toHaveBeenCalled();
    });

    it('returns no capacity without changing a queued party', async () => {
      partyModel.find.mockReturnValue(
        sortedQueryResult([
          {
            _id: new Types.ObjectId(),
            seatedCount: 0,
            queuedCount: 4,
            queueNumber: 100,
            status: PartyStatus.QUEUED,
          },
        ]),
      );

      await expect(service.processQueue()).resolves.toEqual({
        outcome: 'no_capacity',
        processedCount: 0,
        totalSeatedNow: 0,
        remainingQueuedParties: 1,
        processedParties: [],
      });
      expect(tableModel.bulkWrite).not.toHaveBeenCalled();
      expect(partyModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('fully seats queued parties in FIFO order while capacity remains', async () => {
      const parties = [
        {
          _id: new Types.ObjectId(),
          seatedCount: 0,
          queuedCount: 2,
          queueNumber: 100,
          status: PartyStatus.QUEUED,
        },
        {
          _id: new Types.ObjectId(),
          seatedCount: 0,
          queuedCount: 5,
          queueNumber: 101,
          status: PartyStatus.QUEUED,
        },
      ];
      partyModel.find.mockReturnValue(sortedQueryResult(parties));
      tableModel.find.mockReturnValue(
        queryResult([freeTable(1), freeTable(2), freeTable(3)]),
      );
      tableModel.bulkWrite
        .mockResolvedValueOnce({ matchedCount: 1 })
        .mockResolvedValueOnce({ matchedCount: 2 });

      const result = await service.processQueue();

      expect(result).toMatchObject({
        outcome: 'processed',
        processedCount: 2,
        totalSeatedNow: 7,
        remainingQueuedParties: 0,
        processedParties: [
          {
            partyId: parties[0]._id.toString(),
            queueNumber: 100,
            status: PartyStatus.SEATED,
            seatedNow: 2,
            seatedCount: 2,
            queuedCount: 0,
            tables: [{ code: 'T1', seatedCount: 2 }],
          },
          {
            partyId: parties[1]._id.toString(),
            queueNumber: 101,
            status: PartyStatus.SEATED,
            seatedNow: 5,
            seatedCount: 5,
            queuedCount: 0,
            tables: [{ code: 'T2' }, { code: 'T3' }],
          },
        ],
      });
      expect(
        partyModel.findOneAndUpdate.mock.calls.map(
          ([filter]) => filter.queueNumber,
        ),
      ).toEqual([100, 101]);
    });

    it('partially seats only the oldest party and leaves newer parties untouched', async () => {
      const parties = [
        {
          _id: new Types.ObjectId(),
          seatedCount: 0,
          queuedCount: 6,
          queueNumber: 100,
          status: PartyStatus.QUEUED,
        },
        {
          _id: new Types.ObjectId(),
          seatedCount: 0,
          queuedCount: 2,
          queueNumber: 101,
          status: PartyStatus.QUEUED,
        },
      ];
      partyModel.find.mockReturnValue(sortedQueryResult(parties));
      tableModel.find.mockReturnValue(queryResult([freeTable(1)]));
      tableModel.bulkWrite.mockResolvedValue({ matchedCount: 1 });

      await expect(service.processQueue()).resolves.toMatchObject({
        outcome: 'processed',
        processedCount: 1,
        totalSeatedNow: 4,
        remainingQueuedParties: 2,
        processedParties: [
          {
            partyId: parties[0]._id.toString(),
            queueNumber: 100,
            status: PartyStatus.PARTIALLY_SEATED,
            seatedNow: 4,
            queuedCount: 2,
          },
        ],
      });
      expect(partyModel.findOneAndUpdate).toHaveBeenCalledOnce();
      expect(partyModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ queueNumber: 100, queuedCount: 6 }),
        expect.objectContaining({
          $inc: { seatedCount: 4, queuedCount: -4 },
        }),
        expect.objectContaining({ session: sessions[0] }),
      );
    });

    it('appends assignments when finishing a previously partial party', async () => {
      const party = {
        _id: new Types.ObjectId(),
        seatedCount: 4,
        queuedCount: 2,
        queueNumber: 100,
        status: PartyStatus.PARTIALLY_SEATED,
      };
      partyModel.find.mockReturnValue(sortedQueryResult([party]));
      tableModel.find.mockReturnValue(queryResult([freeTable(2)]));
      tableModel.bulkWrite.mockResolvedValue({ matchedCount: 1 });

      await expect(service.processQueue()).resolves.toMatchObject({
        processedParties: [
          {
            status: PartyStatus.SEATED,
            seatedNow: 2,
            seatedCount: 6,
            queuedCount: 0,
          },
        ],
      });
      expect(partyModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: party._id, queuedCount: 2 }),
        expect.objectContaining({
          $inc: { seatedCount: 2, queuedCount: -2 },
          $push: {
            assignments: {
              $each: [expect.objectContaining({ seatedCount: 2 })],
            },
          },
        }),
        expect.any(Object),
      );
    });

    it('retries from fresh state when the queued party changes concurrently', async () => {
      const party = {
        _id: new Types.ObjectId(),
        seatedCount: 0,
        queuedCount: 4,
        queueNumber: 100,
        status: PartyStatus.QUEUED,
      };
      partyModel.find.mockReturnValue(sortedQueryResult([party]));
      tableModel.find.mockReturnValue(queryResult([freeTable(1)]));
      tableModel.bulkWrite.mockResolvedValue({ matchedCount: 1 });
      partyModel.findOneAndUpdate
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({});

      await expect(service.processQueue()).resolves.toMatchObject({
        outcome: 'processed',
        processedCount: 1,
      });
      expect(connection.startSession).toHaveBeenCalledTimes(2);
      expect(tableModel.bulkWrite).toHaveBeenCalledTimes(2);
      expect(sessions[0].endSession).toHaveBeenCalledOnce();
      expect(sessions[1].endSession).toHaveBeenCalledOnce();
    });
  });

  describe('releaseTable', () => {
    it('frees the table and completes a party after its final release', async () => {
      const partyId = new Types.ObjectId();
      const occupiedTable = {
        ...freeTable(1),
        status: TableStatus.OCCUPIED,
        partyId,
        occupiedSeats: 4,
      };
      const party = {
        _id: partyId,
        seatedCount: 4,
        queuedCount: 0,
        departedCount: 0,
      };
      tableModel.findOne.mockReturnValue(queryResult(occupiedTable));
      partyModel.findById.mockReturnValue(queryResult(party));

      const result = await service.releaseTable('T1');

      expect(result).toEqual({
        table: {
          code: 'T1',
          status: TableStatus.FREE,
          releasedSeats: 4,
        },
        party: {
          partyId: partyId.toString(),
          status: PartyStatus.COMPLETED,
          seatedCount: 0,
          queuedCount: 0,
          departedCount: 4,
        },
        queueReprocessed: false,
      });
      expect(tableModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: occupiedTable._id, partyId }),
        {
          $set: {
            status: TableStatus.FREE,
            partyId: null,
            occupiedSeats: 0,
          },
        },
        { returnDocument: 'after', session: sessions[0] },
      );
      expect(partyModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: partyId }),
        expect.objectContaining({
          $set: expect.objectContaining({
            seatedCount: 0,
            departedCount: 4,
            status: PartyStatus.COMPLETED,
          }),
        }),
        expect.objectContaining({
          returnDocument: 'after',
          session: sessions[0],
        }),
      );
    });

    it('keeps queued guests queued and does not auto-process the queue', async () => {
      const partyId = new Types.ObjectId();
      const occupiedTable = {
        ...freeTable(1),
        status: TableStatus.OCCUPIED,
        partyId,
        occupiedSeats: 4,
      };
      tableModel.findOne.mockReturnValue(queryResult(occupiedTable));
      partyModel.findById.mockReturnValue(
        queryResult({
          _id: partyId,
          seatedCount: 4,
          queuedCount: 2,
          departedCount: 0,
        }),
      );

      await expect(service.releaseTable('T1')).resolves.toMatchObject({
        party: {
          status: PartyStatus.QUEUED,
          seatedCount: 0,
          queuedCount: 2,
        },
        queueReprocessed: false,
      });
    });

    it('rejects an unknown table', async () => {
      tableModel.findOne.mockReturnValue(queryResult(null));

      await expect(service.releaseTable('T99')).rejects.toThrow(
        'Table T99 was not found',
      );
      expect(partyModel.findById).not.toHaveBeenCalled();
      expect(sessions[0].endSession).toHaveBeenCalledOnce();
    });

    it('rejects a table that is already free', async () => {
      tableModel.findOne.mockReturnValue(queryResult(freeTable(1)));

      await expect(service.releaseTable('T1')).rejects.toThrow(
        'Table T1 is already free',
      );
      expect(tableModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
