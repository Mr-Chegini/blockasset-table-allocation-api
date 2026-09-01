import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import {
  DEFAULT_RESTAURANT_CONFIG_KEY,
  RestaurantConfig,
} from '../restaurant/schemas/restaurant-config.schema.js';
import { Table, TableStatus } from '../restaurant/schemas/table.schema.js';
import { CreateAllocationDto } from './dto/create-allocation.dto.js';
import { Counter, QUEUE_COUNTER_KEY } from './schemas/counter.schema.js';
import { Party, PartyStatus } from './schemas/party.schema.js';
import { AvailableTable, selectTables } from './table-selector.js';

const MAX_ALLOCATION_ATTEMPTS = 3;

class TableReservationConflict extends Error {}

interface AssignedTable {
  tableId: Types.ObjectId;
  code: string;
  capacity: number;
  seatedCount: number;
  status: TableStatus.PARTIAL | TableStatus.OCCUPIED;
}

export interface AllocationResponse {
  partyId: string;
  status: PartyStatus;
  originalHeadcount: number;
  seatedCount: number;
  queuedCount: number;
  tables: Array<{
    code: string;
    capacity: number;
    seatedCount: number;
    status: TableStatus.PARTIAL | TableStatus.OCCUPIED;
  }>;
  queue: { queueNumber: number; headcount: number } | null;
}

@Injectable()
export class AllocationService {
  constructor(
    @InjectModel(RestaurantConfig.name)
    private readonly restaurantConfigModel: Model<RestaurantConfig>,
    @InjectModel(Table.name)
    private readonly tableModel: Model<Table>,
    @InjectModel(Party.name)
    private readonly partyModel: Model<Party>,
    @InjectModel(Counter.name)
    private readonly counterModel: Model<Counter>,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  async allocate(dto: CreateAllocationDto): Promise<AllocationResponse> {
    for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const session = await this.connection.startSession();

      try {
        let response: AllocationResponse | undefined;

        await session.withTransaction(async () => {
          response = await this.allocateInTransaction(dto.headcount, session);
        });

        if (response === undefined) {
          throw new Error(
            'Allocation transaction completed without a response',
          );
        }

        return response;
      } catch (error) {
        if (
          error instanceof TableReservationConflict &&
          attempt < MAX_ALLOCATION_ATTEMPTS
        ) {
          continue;
        }

        if (error instanceof TableReservationConflict) {
          throw new ConflictException(
            'Tables changed during allocation; please retry the request',
          );
        }

        throw error;
      } finally {
        await session.endSession();
      }
    }

    throw new ConflictException('Unable to allocate tables; please retry');
  }

  private async allocateInTransaction(
    headcount: number,
    session: ClientSession,
  ): Promise<AllocationResponse> {
    const configuration = await this.restaurantConfigModel
      .findOne({ key: DEFAULT_RESTAURANT_CONFIG_KEY })
      .session(session)
      .lean();

    if (configuration === null) {
      throw new ConflictException('Restaurant has not been configured');
    }

    const physicalCapacity =
      configuration.tableCount * configuration.chairsPerTable;

    if (headcount > physicalCapacity) {
      throw new BadRequestException(
        `Headcount cannot exceed restaurant capacity of ${physicalCapacity}`,
      );
    }

    const freeTables = await this.tableModel
      .find({ status: TableStatus.FREE, partyId: null })
      .session(session)
      .lean();
    const availableTables: AvailableTable[] = freeTables.map((table) => ({
      id: table._id.toString(),
      code: table.code,
      tableNumber: table.tableNumber,
      capacity: table.capacity,
    }));
    const selection = selectTables(headcount, availableTables);
    const partyId = new Types.ObjectId();
    const assignedTables = this.buildAssignments(
      selection.selectedTables,
      selection.seatedCount,
    );

    if (assignedTables.length > 0) {
      const claimResult = await this.tableModel.bulkWrite(
        assignedTables.map((assignment) => ({
          updateOne: {
            filter: {
              _id: assignment.tableId,
              status: TableStatus.FREE,
              partyId: null,
            },
            update: {
              $set: {
                status: assignment.status,
                partyId,
                occupiedSeats: assignment.seatedCount,
              },
            },
          },
        })),
        { session },
      );

      if (claimResult.matchedCount !== assignedTables.length) {
        throw new TableReservationConflict();
      }
    }

    const queueNumber =
      selection.unseatedCount > 0 ? await this.nextQueueNumber(session) : null;
    const status = this.getPartyStatus(
      selection.seatedCount,
      selection.unseatedCount,
    );
    const assignedAt = new Date();

    await this.partyModel.create(
      [
        {
          _id: partyId,
          originalHeadcount: headcount,
          seatedCount: selection.seatedCount,
          queuedCount: selection.unseatedCount,
          departedCount: 0,
          status,
          queueNumber,
          assignments: assignedTables.map((assignment) => ({
            tableId: assignment.tableId,
            seatedCount: assignment.seatedCount,
            assignedAt,
            releasedAt: null,
          })),
          completedAt: null,
        },
      ],
      { session },
    );

    return {
      partyId: partyId.toString(),
      status,
      originalHeadcount: headcount,
      seatedCount: selection.seatedCount,
      queuedCount: selection.unseatedCount,
      tables: assignedTables.map(({ code, capacity, seatedCount, status }) => ({
        code,
        capacity,
        seatedCount,
        status,
      })),
      queue:
        queueNumber === null
          ? null
          : { queueNumber, headcount: selection.unseatedCount },
    };
  }

  private buildAssignments(
    selectedTables: readonly AvailableTable[],
    seatedCount: number,
  ): AssignedTable[] {
    let remaining = seatedCount;

    return selectedTables.map((table) => {
      const assignedCount = Math.min(table.capacity, remaining);
      remaining -= assignedCount;

      return {
        tableId: new Types.ObjectId(table.id),
        code: table.code,
        capacity: table.capacity,
        seatedCount: assignedCount,
        status:
          assignedCount === table.capacity
            ? TableStatus.OCCUPIED
            : TableStatus.PARTIAL,
      };
    });
  }

  private async nextQueueNumber(session: ClientSession): Promise<number> {
    const counter = await this.counterModel.findOneAndUpdate(
      { key: QUEUE_COUNTER_KEY },
      [
        {
          $set: {
            sequence: {
              $add: [{ $ifNull: ['$sequence', 99] }, 1],
            },
          },
        },
      ],
      { new: true, upsert: true, session },
    );

    if (counter === null) {
      throw new Error('Failed to generate a queue number');
    }

    return counter.sequence;
  }

  private getPartyStatus(
    seatedCount: number,
    queuedCount: number,
  ): PartyStatus {
    if (queuedCount === 0) {
      return PartyStatus.SEATED;
    }

    return seatedCount === 0
      ? PartyStatus.QUEUED
      : PartyStatus.PARTIALLY_SEATED;
  }
}
