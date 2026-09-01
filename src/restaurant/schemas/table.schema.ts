import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum TableStatus {
  FREE = 'free',
  PARTIAL = 'partial',
  OCCUPIED = 'occupied',
}

@Schema({
  timestamps: true,
  versionKey: false,
})
export class Table {
  @Prop({
    required: true,
    unique: true,
    trim: true,
  })
  code: string;

  @Prop({
    required: true,
    unique: true,
    min: 1,
  })
  tableNumber: number;

  @Prop({
    required: true,
    min: 1,
  })
  capacity: number;

  @Prop({
    type: String,
    required: true,
    enum: TableStatus,
    default: TableStatus.FREE,
    index: true,
  })
  status: TableStatus;

  @Prop({
    type: Types.ObjectId,
    ref: 'Party',
    default: null,
    index: true,
  })
  partyId: Types.ObjectId | null;

  @Prop({
    required: true,
    min: 0,
    default: 0,
  })
  occupiedSeats: number;
}

export type TableDocument = HydratedDocument<Table>;

export const TableSchema = SchemaFactory.createForClass(Table);

TableSchema.index({
  status: 1,
  capacity: 1,
  code: 1,
});
