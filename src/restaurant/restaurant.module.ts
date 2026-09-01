import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RestaurantController } from './restaurant.controller.js';
import {
  RestaurantConfig,
  RestaurantConfigSchema,
} from './schemas/restaurant-config.schema.js';
import { Table, TableSchema } from './schemas/table.schema.js';
import { RestaurantService } from './restaurant.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: RestaurantConfig.name,
        schema: RestaurantConfigSchema,
      },
      {
        name: Table.name,
        schema: TableSchema,
      },
    ]),
  ],
  controllers: [RestaurantController],
  providers: [RestaurantService],
  exports: [MongooseModule, RestaurantService],
})
export class RestaurantModule {}
