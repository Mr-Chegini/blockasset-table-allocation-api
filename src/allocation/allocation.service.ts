import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';

import {
  DEFAULT_RESTAURANT_CONFIG_KEY,
  RestaurantConfig,
} from '../restaurant/schemas/restaurant-config.schema.js';
import { Table, TableStatus } from '../restaurant/schemas/table.schema.js';
import { CreateAllocationDto } from './dto/create-allocation.dto.js';
import { Counter, QUEUE_COUNTER_KEY } from './schemas/counter.schema.js';
import { Party, PartyStatus } from './schemas/party.schema.js';
import { selectTables } from './table-selector.js';
import type { AvailableTable } from './table-selector.js';

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

export interface TableReleaseResponse {
  table: {
    code: string;
    status: TableStatus.FREE;
    releasedSeats: number;
  };
  party: {
    partyId: string;
    status: PartyStatus;
    seatedCount: number;
    queuedCount: number;
    departedCount: number;
  };
  queueReprocessed: false;
}

export interface QueueProcessingResponse {
  outcome: 'queue_empty' | 'no_capacity' | 'processed';
  processedCount: number;
  totalSeatedNow: number;
  remainingQueuedParties: number;
  processedParties: Array<{
    partyId: string;
    queueNumber: number;
    status: PartyStatus;
    seatedNow: number;
    seatedCount: number;
    queuedCount: number;
    tables: Array<{
      code: string;
      capacity: number;
      seatedCount: number;
      status: TableStatus.PARTIAL | TableStatus.OCCUPIED;
    }>;
  }>;
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

  async getQueue() {
    const parties = await this.partyModel
      .find(this.getActiveQueueFilter(), {
        originalHeadcount: 1,
        seatedCount: 1,
        queuedCount: 1,
        queueNumber: 1,
        createdAt: 1,
      })
      .sort({ queueNumber: 1 })
      .lean();

    return {
      count: parties.length,
      entries: parties.map((party, index) => ({
        position: index + 1,
        partyId: party._id.toString(),
        queueNumber: party.queueNumber,
        headcount: party.queuedCount,
        originalHeadcount: party.originalHeadcount,
        seatedCount: party.seatedCount,
        queuedAt: party.createdAt,
      })),
    };
  }

  async processQueue(): Promise<QueueProcessingResponse> {
    for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const session = await this.connection.startSession();

      try {
        let response: QueueProcessingResponse | undefined;

        await session.withTransaction(async () => {
          response = await this.processQueueInTransaction(session);
        });

        if (response === undefined) {
          throw new Error(
            'Queue-processing transaction completed without a response',
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
            'Queue changed during processing; please retry the request',
          );
        }

        throw error;
      } finally {
        await session.endSession();
      }
    }

    throw new ConflictException('Unable to process the queue; please retry');
  }

  async releaseTable(code: string): Promise<TableReleaseResponse> {
    const session = await this.connection.startSession();

    try {
      let response: TableReleaseResponse | undefined;

      await session.withTransaction(async () => {
        const table = await this.tableModel
          .findOne({ code })
          .session(session)
          .lean();

        if (table === null) {
          throw new NotFoundException(`Table ${code} was not found`);
        }

        if (table.status === TableStatus.FREE || table.partyId === null) {
          throw new ConflictException(`Table ${code} is already free`);
        }

        const party = await this.partyModel
          .findById(table.partyId)
          .session(session)
          .lean();

        if (party === null) {
          throw new ConflictException(
            `Table ${code} has no corresponding active party`,
          );
        }

        const releasedAt = new Date();
        const seatedCount = party.seatedCount - table.occupiedSeats;
        const departedCount = party.departedCount + table.occupiedSeats;
        const status = this.getStatusAfterRelease(
          seatedCount,
          party.queuedCount,
        );
        const completedAt =
          status === PartyStatus.COMPLETED ? releasedAt : null;
        const releasedTable = await this.tableModel.findOneAndUpdate(
          {
            _id: table._id,
            status: table.status,
            partyId: table.partyId,
          },
          {
            $set: {
              status: TableStatus.FREE,
              partyId: null,
              occupiedSeats: 0,
            },
          },
          { returnDocument: 'after', session },
        );

        if (releasedTable === null) {
          throw new ConflictException(
            `Table ${code} changed while it was being released`,
          );
        }

        const updatedParty = await this.partyModel.findOneAndUpdate(
          {
            _id: party._id,
            assignments: {
              $elemMatch: { tableId: table._id, releasedAt: null },
            },
          },
          {
            $set: {
              seatedCount,
              departedCount,
              status,
              completedAt,
              'assignments.$[assignment].releasedAt': releasedAt,
            },
          },
          {
            arrayFilters: [
              {
                'assignment.tableId': table._id,
                'assignment.releasedAt': null,
              },
            ],
            returnDocument: 'after',
            session,
          },
        );

        if (updatedParty === null) {
          throw new ConflictException(
            `The assignment for table ${code} is no longer active`,
          );
        }

        response = {
          table: {
            code: table.code,
            status: TableStatus.FREE,
            releasedSeats: table.occupiedSeats,
          },
          party: {
            partyId: party._id.toString(),
            status,
            seatedCount,
            queuedCount: party.queuedCount,
            departedCount,
          },
          queueReprocessed: false,
        };
      });

      if (response === undefined) {
        throw new Error('Release transaction completed without a response');
      }

      return response;
    } finally {
      await session.endSession();
    }
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

    const activeQueue = await this.partyModel
      .exists(this.getActiveQueueFilter())
      .session(session);
    const freeTables = activeQueue
      ? []
      : await this.tableModel
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

  private async processQueueInTransaction(
    session: ClientSession,
  ): Promise<QueueProcessingResponse> {
    const queuedParties = await this.partyModel
      .find(this.getActiveQueueFilter())
      .sort({ queueNumber: 1 })
      .session(session)
      .lean();

    if (queuedParties.length === 0) {
      return {
        outcome: 'queue_empty',
        processedCount: 0,
        totalSeatedNow: 0,
        remainingQueuedParties: 0,
        processedParties: [],
      };
    }

    const freeTables = await this.tableModel
      .find({ status: TableStatus.FREE, partyId: null })
      .session(session)
      .lean();
    let availableTables: AvailableTable[] = freeTables.map((table) => ({
      id: table._id.toString(),
      code: table.code,
      tableNumber: table.tableNumber,
      capacity: table.capacity,
    }));

    if (availableTables.length === 0) {
      return {
        outcome: 'no_capacity',
        processedCount: 0,
        totalSeatedNow: 0,
        remainingQueuedParties: queuedParties.length,
        processedParties: [],
      };
    }

    const processedParties: QueueProcessingResponse['processedParties'] = [];
    let totalSeatedNow = 0;
    let fullySeatedParties = 0;

    for (const party of queuedParties) {
      if (availableTables.length === 0) {
        break;
      }

      const selection = selectTables(party.queuedCount, availableTables);
      const assignedTables = this.buildAssignments(
        selection.selectedTables,
        selection.seatedCount,
      );
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
                partyId: party._id,
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

      const seatedCount = party.seatedCount + selection.seatedCount;
      const queuedCount = party.queuedCount - selection.seatedCount;
      const status = this.getPartyStatus(seatedCount, queuedCount);
      const assignedAt = new Date();
      const updatedParty = await this.partyModel.findOneAndUpdate(
        {
          _id: party._id,
          queueNumber: party.queueNumber,
          queuedCount: party.queuedCount,
          status: party.status,
        },
        {
          $inc: {
            seatedCount: selection.seatedCount,
            queuedCount: -selection.seatedCount,
          },
          $set: { status },
          $push: {
            assignments: {
              $each: assignedTables.map((assignment) => ({
                tableId: assignment.tableId,
                seatedCount: assignment.seatedCount,
                assignedAt,
                releasedAt: null,
              })),
            },
          },
        },
        { returnDocument: 'after', session },
      );

      if (updatedParty === null) {
        throw new TableReservationConflict();
      }

      const selectedIds = new Set(
        assignedTables.map(({ tableId }) => tableId.toString()),
      );
      availableTables = availableTables.filter(
        ({ id }) => !selectedIds.has(id),
      );
      totalSeatedNow += selection.seatedCount;

      if (queuedCount === 0) {
        fullySeatedParties += 1;
      }

      processedParties.push({
        partyId: party._id.toString(),
        queueNumber: party.queueNumber as number,
        status,
        seatedNow: selection.seatedCount,
        seatedCount,
        queuedCount,
        tables: assignedTables.map(
          ({ code, capacity, seatedCount: tableSeatedCount, status }) => ({
            code,
            capacity,
            seatedCount: tableSeatedCount,
            status,
          }),
        ),
      });

      if (queuedCount > 0) {
        break;
      }
    }

    return {
      outcome: 'processed',
      processedCount: processedParties.length,
      totalSeatedNow,
      remainingQueuedParties: queuedParties.length - fullySeatedParties,
      processedParties,
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
      {
        returnDocument: 'after',
        upsert: true,
        updatePipeline: true,
        session,
      },
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

  private getStatusAfterRelease(
    seatedCount: number,
    queuedCount: number,
  ): PartyStatus {
    if (seatedCount === 0 && queuedCount === 0) {
      return PartyStatus.COMPLETED;
    }

    if (queuedCount === 0) {
      return PartyStatus.SEATED;
    }

    return seatedCount === 0
      ? PartyStatus.QUEUED
      : PartyStatus.PARTIALLY_SEATED;
  }

  private getActiveQueueFilter() {
    return {
      queuedCount: { $gt: 0 },
      queueNumber: { $ne: null },
      status: {
        $in: [PartyStatus.QUEUED, PartyStatus.PARTIALLY_SEATED],
      },
    };
  }
}
