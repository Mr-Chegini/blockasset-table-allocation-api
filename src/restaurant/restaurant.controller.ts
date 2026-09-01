import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ConfigureRestaurantDto } from './dto/configure-restaurant.dto.js';
import { RestaurantService } from './restaurant.service.js';

@ApiTags('Owner')
@Controller('owner/restaurant')
export class RestaurantController {
  constructor(private readonly restaurantService: RestaurantService) {}

  @Put('configuration')
  @ApiOperation({ summary: 'Configure the restaurant and generate its tables' })
  @ApiOkResponse({ description: 'Restaurant configured successfully' })
  @ApiConflictResponse({
    description:
      'The restaurant cannot be reconfigured while a table is in use',
  })
  configure(@Body() dto: ConfigureRestaurantDto) {
    return this.restaurantService.configure(dto);
  }

  @Get('tables')
  @ApiOperation({ summary: 'View the current state of every table' })
  @ApiOkResponse({ description: 'Current table state and status counts' })
  getTables() {
    return this.restaurantService.getTables();
  }
}
