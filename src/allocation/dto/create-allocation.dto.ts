import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class CreateAllocationDto {
  @ApiProperty({
    example: 7,
    minimum: 1,
    description: 'Number of people in the arriving party',
  })
  @IsInt()
  @Min(1)
  headcount: number;
}
