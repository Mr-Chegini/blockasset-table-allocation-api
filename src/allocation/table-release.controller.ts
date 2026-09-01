import { Controller, HttpCode, HttpStatus, Param, Patch } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AllocationService } from './allocation.service.js';

@ApiTags('Owner')
@Controller('owner/tables')
export class TableReleaseController {
  constructor(private readonly allocationService: AllocationService) {}

  @Patch(':code/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release an occupied or partial table' })
  @ApiParam({ name: 'code', example: 'T1' })
  @ApiOkResponse({ description: 'Table released successfully' })
  @ApiNotFoundResponse({ description: 'Table does not exist' })
  @ApiConflictResponse({ description: 'Table is already free' })
  release(@Param('code') code: string) {
    return this.allocationService.releaseTable(code);
  }
}
