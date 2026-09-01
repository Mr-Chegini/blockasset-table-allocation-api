import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AllocationService } from './allocation.service.js';
import { CreateAllocationDto } from './dto/create-allocation.dto.js';

@ApiTags('Customer')
@Controller('customer')
export class AllocationController {
  constructor(private readonly allocationService: AllocationService) {}

  @Post('allocations')
  @ApiOperation({
    summary: 'Seat a party and queue any unseated guests',
    description:
      'When an active queue exists, the new party joins it without claiming free tables.',
  })
  @ApiCreatedResponse({ description: 'Party allocation was persisted' })
  @ApiBadRequestResponse({
    description: 'Headcount is invalid or exceeds physical capacity',
  })
  @ApiConflictResponse({
    description: 'Restaurant is not configured or allocation is too busy',
  })
  create(@Body() dto: CreateAllocationDto) {
    return this.allocationService.allocate(dto);
  }

  @Get('queue')
  @ApiOperation({ summary: 'View the current customer queue' })
  @ApiOkResponse({ description: 'Queue entries in arrival order' })
  getQueue() {
    return this.allocationService.getQueue();
  }
}
