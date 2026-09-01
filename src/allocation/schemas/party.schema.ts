import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

export enum PartyStatus {
  SEATED = 'seated',
  PARTIALLY_SEATED = 'partially_seated',
  QUEUED = 'queued',
  COMPLETED = 'completed',
}

@Schema({
  _id: false,
  versionKey: false,
})
export class TableAssignment {
  @Prop({
    type: Types.ObjectId,
    ref: 'Table',
    required: true,
  })
  tableId: Types.ObjectId;

  @Prop({
    required: true,
    min: 1,
  })
  seatedCount: number;

  @Prop({
    required: true,
    default: Date.now,
  })
  assignedAt: Date;

  @Prop({
    type: Date,
    default: null,
  })
  releasedAt: Date | null;
}

export const TableAssignmentSchema =
  SchemaFactory.createForClass(TableAssignment);

@Schema({
  timestamps: true,
  versionKey: false,
})
export class Party {
  createdAt: Date;

  updatedAt: Date;

  @Prop({
    required: true,
    min: 1,
  })
  originalHeadcount: number;

  @Prop({
    required: true,
    min: 0,
    default: 0,
  })
  seatedCount: number;

  @Prop({
    required: true,
    min: 0,
    default: 0,
  })
  queuedCount: number;

  @Prop({
    required: true,
    min: 0,
    default: 0,
  })
  departedCount: number;

  @Prop({
    required: true,
    min: 0,
    default: 0,
  })
  cancelledCount: number;

  @Prop({
    type: String,
    required: true,
    enum: PartyStatus,
  })
  status: PartyStatus;

  @Prop({
    type: Number,
    min: 100,
    default: null,
  })
  queueNumber: number | null;

  @Prop({
    type: [TableAssignmentSchema],
    default: [],
  })
  assignments: TableAssignment[];

  @Prop({
    type: Date,
    default: null,
  })
  completedAt: Date | null;
}

export type PartyDocument = HydratedDocument<Party>;

export const PartySchema = SchemaFactory.createForClass(Party);

PartySchema.index(
  {
    queueNumber: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      queueNumber: {
        $type: 'number',
      },
    },
  },
);

PartySchema.index({
  status: 1,
  queueNumber: 1,
});
