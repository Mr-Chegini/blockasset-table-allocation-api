import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const QUEUE_COUNTER_KEY = 'queue';

@Schema({
  timestamps: true,
  versionKey: false,
})
export class Counter {
  @Prop({
    required: true,
    unique: true,
    immutable: true,
    trim: true,
  })
  key: string;

  @Prop({
    required: true,
    min: 99,
    default: 99,
  })
  sequence: number;
}

export type CounterDocument = HydratedDocument<Counter>;

export const CounterSchema = SchemaFactory.createForClass(Counter);
