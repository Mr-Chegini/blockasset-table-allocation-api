import { ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import { ConfigureRestaurantDto } from './dto/configure-restaurant.dto.js';
import {
  DEFAULT_RESTAURANT_CONFIG_KEY,
  RestaurantConfig,
} from './schemas/restaurant-config.schema.js';
import { Table, TableStatus } from './schemas/table.schema.js';

@Injectable()
export class RestaurantService {
  constructor(
    @InjectModel(RestaurantConfig.name)
    private readonly restaurantConfigModel: Model<RestaurantConfig>,
    @InjectModel(Table.name)
    private readonly tableModel: Model<Table>,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  async configure(dto: ConfigureRestaurantDto) {
    const session = await this.connection.startSession();

    try {
      await session.withTransaction(async () => {
        const queuedParty = await this.connection
          .collection('parties')
          .findOne(
            { queuedCount: { $gt: 0 } },
            { projection: { _id: 1 }, session },
          );

        if (queuedParty) {
          throw new ConflictException(
            'Restaurant cannot be reconfigured while guests are queued',
          );
        }

        const tableInUse = await this.tableModel
          .exists({ status: { $ne: TableStatus.FREE } })
          .session(session);

        if (tableInUse) {
          throw new ConflictException(
            'Restaurant cannot be reconfigured while a table is in use',
          );
        }

        await this.restaurantConfigModel.findOneAndUpdate(
          { key: DEFAULT_RESTAURANT_CONFIG_KEY },
          {
            $set: {
              tableCount: dto.tableCount,
              chairsPerTable: dto.chairsPerTable,
            },
            $setOnInsert: { key: DEFAULT_RESTAURANT_CONFIG_KEY },
          },
          {
            returnDocument: 'after',
            upsert: true,
            runValidators: true,
            session,
          },
        );

        await this.tableModel.deleteMany({}).session(session);
        await this.tableModel.insertMany(
          Array.from({ length: dto.tableCount }, (_, index) => ({
            code: `T${index + 1}`,
            tableNumber: index + 1,
            capacity: dto.chairsPerTable,
            status: TableStatus.FREE,
            partyId: null,
            occupiedSeats: 0,
          })),
          { session },
        );
      });

      return {
        configuration: {
          tableCount: dto.tableCount,
          chairsPerTable: dto.chairsPerTable,
          totalCapacity: dto.tableCount * dto.chairsPerTable,
        },
        generatedTables: dto.tableCount,
      };
    } finally {
      await session.endSession();
    }
  }

  async getTables() {
    const tables = await this.tableModel
      .find({}, { _id: 0, code: 1, capacity: 1, status: 1, occupiedSeats: 1 })
      .sort({ tableNumber: 1 })
      .lean();

    const counts = {
      total: tables.length,
      free: 0,
      partial: 0,
      occupied: 0,
    };

    for (const table of tables) {
      counts[table.status] += 1;
    }

    return { counts, tables };
  }
}
