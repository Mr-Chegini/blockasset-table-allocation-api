import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AllocationService } from './allocation.service.js';

@ApiTags('Owner')
@Controller('owner/queue')
export class QueueProcessingController {
  constructor(private readonly allocationService: AllocationService) {}

  @Post('process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Seat queued parties in strict queue-number order',
    description:
      'Processes the oldest active queue entry first and never bypasses a party that remains queued.',
  })
  @ApiOkResponse({
    description:
      'Queue processing completed, or no queued party/free table was available',
    schema: {
      example: {
        outcome: 'processed',
        processedCount: 1,
        totalSeatedNow: 4,
        remainingQueuedParties: 1,
        processedParties: [
          {
            partyId: '68b700000000000000000001',
            queueNumber: 100,
            status: 'partially_seated',
            seatedNow: 4,
            seatedCount: 8,
            queuedCount: 2,
            tables: [
              {
                code: 'T1',
                capacity: 4,
                seatedCount: 4,
                status: 'occupied',
              },
            ],
          },
        ],
      },
    },
  })
  @ApiConflictResponse({
    description: 'Queue or table state remained contended after retries',
  })
  process() {
    return this.allocationService.processQueue();
  }
}
