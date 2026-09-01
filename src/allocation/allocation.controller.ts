import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AllocationService } from './allocation.service.js';
import { CreateAllocationDto } from './dto/create-allocation.dto.js';

@ApiTags('Customer')
@Controller('customer/allocations')
export class AllocationController {
  constructor(private readonly allocationService: AllocationService) {}

  @Post()
  @ApiOperation({ summary: 'Seat a party and queue any unseated guests' })
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
}
