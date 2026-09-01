import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const DEFAULT_RESTAURANT_CONFIG_KEY = 'default';

@Schema({
  timestamps: true,
  versionKey: false,
})
export class RestaurantConfig {
  @Prop({
    required: true,
    unique: true,
    immutable: true,
    default: DEFAULT_RESTAURANT_CONFIG_KEY,
  })
  key: string;

  @Prop({
    required: true,
    min: 1,
  })
  tableCount: number;

  @Prop({
    required: true,
    min: 1,
  })
  chairsPerTable: number;
}

export type RestaurantConfigDocument = HydratedDocument<RestaurantConfig>;

export const RestaurantConfigSchema =
  SchemaFactory.createForClass(RestaurantConfig);
