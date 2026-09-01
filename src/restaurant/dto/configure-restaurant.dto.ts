import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ConfigureRestaurantDto {
  @ApiProperty({
    example: 10,
    minimum: 1,
    description: 'Total number of tables',
  })
  @IsInt()
  @Min(1)
  tableCount: number;

  @ApiProperty({
    example: 4,
    minimum: 1,
    description: 'Number of chairs per table',
  })
  @IsInt()
  @Min(1)
  chairsPerTable: number;
}
