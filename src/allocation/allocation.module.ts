import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RestaurantModule } from '../restaurant/restaurant.module.js';
import { AllocationController } from './allocation.controller.js';
import { AllocationService } from './allocation.service.js';
import { Counter, CounterSchema } from './schemas/counter.schema.js';
import { Party, PartySchema } from './schemas/party.schema.js';
import { QueueProcessingController } from './queue-processing.controller.js';
import { TableReleaseController } from './table-release.controller.js';

@Module({
  imports: [
    RestaurantModule,
    MongooseModule.forFeature([
      { name: Counter.name, schema: CounterSchema },
      { name: Party.name, schema: PartySchema },
    ]),
  ],
  controllers: [
    AllocationController,
    QueueProcessingController,
    TableReleaseController,
  ],
  providers: [AllocationService],
})
export class AllocationModule {}
