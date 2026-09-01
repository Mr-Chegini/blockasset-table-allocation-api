import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AppService } from './app.service.js';

@ApiTags('Health')
@Controller('health')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Check whether the API process is available' })
  @ApiOkResponse({ description: 'API process is healthy' })
  getHealth() {
    return this.appService.getHealth();
  }
}
