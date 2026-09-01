import { ConflictException } from '@nestjs/common';
import { Connection, Model } from 'mongoose';

import { RestaurantConfig } from './schemas/restaurant-config.schema.js';
import { Table, TableStatus } from './schemas/table.schema.js';
import { RestaurantService } from './restaurant.service.js';

describe('RestaurantService', () => {
  const session = {
    withTransaction: vi.fn(),
    endSession: vi.fn(),
  };
  const restaurantConfigModel = {
    findOneAndUpdate: vi.fn(),
  };
  const tableModel = {
    exists: vi.fn(),
    deleteMany: vi.fn(),
    insertMany: vi.fn(),
    find: vi.fn(),
  };
  const connection = {
    startSession: vi.fn(),
    collection: vi.fn(),
  };
  const partyCollection = {
    findOne: vi.fn(),
  };

  let service: RestaurantService;

  beforeEach(() => {
    vi.clearAllMocks();
    session.withTransaction.mockImplementation(async (work) => work());
    connection.startSession.mockResolvedValue(session);
    connection.collection.mockReturnValue(partyCollection);
    partyCollection.findOne.mockResolvedValue(null);
    tableModel.exists.mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    });
    tableModel.deleteMany.mockReturnValue({
      session: vi.fn().mockResolvedValue({ acknowledged: true }),
    });
    tableModel.insertMany.mockResolvedValue([]);
    restaurantConfigModel.findOneAndUpdate.mockResolvedValue({
      key: 'default',
      tableCount: 3,
      chairsPerTable: 4,
    });

    service = new RestaurantService(
      restaurantConfigModel as unknown as Model<RestaurantConfig>,
      tableModel as unknown as Model<Table>,
      connection as unknown as Connection,
    );
  });

  describe('configure', () => {
    it('stores the configuration and generates sequential free tables', async () => {
      const result = await service.configure({
        tableCount: 3,
        chairsPerTable: 4,
      });

      expect(session.withTransaction).toHaveBeenCalledOnce();
      expect(restaurantConfigModel.findOneAndUpdate).toHaveBeenCalledWith(
        { key: 'default' },
        expect.objectContaining({
          $set: { tableCount: 3, chairsPerTable: 4 },
        }),
        expect.objectContaining({
          returnDocument: 'after',
          upsert: true,
          runValidators: true,
          session,
        }),
      );
      expect(tableModel.insertMany).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            code: 'T1',
            tableNumber: 1,
            capacity: 4,
            status: TableStatus.FREE,
          }),
          expect.objectContaining({ code: 'T2', tableNumber: 2 }),
          expect.objectContaining({ code: 'T3', tableNumber: 3 }),
        ],
        { session },
      );
      expect(result).toEqual({
        configuration: {
          tableCount: 3,
          chairsPerTable: 4,
          totalCapacity: 12,
        },
        generatedTables: 3,
      });
      expect(session.endSession).toHaveBeenCalledOnce();
    });

    it('rejects reconfiguration when any table is in use', async () => {
      tableModel.exists.mockReturnValue({
        session: vi.fn().mockResolvedValue({ _id: 'occupied-table' }),
      });

      await expect(
        service.configure({ tableCount: 2, chairsPerTable: 2 }),
      ).rejects.toThrow(ConflictException);

      expect(restaurantConfigModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(tableModel.deleteMany).not.toHaveBeenCalled();
      expect(tableModel.insertMany).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledOnce();
    });

    it('rejects reconfiguration while guests remain queued', async () => {
      partyCollection.findOne.mockResolvedValue({ _id: 'queued-party' });

      await expect(
        service.configure({ tableCount: 2, chairsPerTable: 2 }),
      ).rejects.toThrow(ConflictException);

      expect(tableModel.exists).not.toHaveBeenCalled();
      expect(restaurantConfigModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(tableModel.deleteMany).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledOnce();
    });
  });

  describe('getTables', () => {
    it('returns table details with counts for each status', async () => {
      const tables = [
        {
          code: 'T1',
          capacity: 4,
          status: TableStatus.FREE,
          occupiedSeats: 0,
        },
        {
          code: 'T2',
          capacity: 4,
          status: TableStatus.PARTIAL,
          occupiedSeats: 2,
        },
        {
          code: 'T3',
          capacity: 4,
          status: TableStatus.OCCUPIED,
          occupiedSeats: 4,
        },
      ];
      const lean = vi.fn().mockResolvedValue(tables);
      const sort = vi.fn().mockReturnValue({ lean });
      tableModel.find.mockReturnValue({ sort });

      await expect(service.getTables()).resolves.toEqual({
        counts: { total: 3, free: 1, partial: 1, occupied: 1 },
        tables,
      });
      expect(sort).toHaveBeenCalledWith({ tableNumber: 1 });
    });
  });
});
