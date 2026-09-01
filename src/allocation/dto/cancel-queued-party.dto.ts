import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

import { PartyStatus } from '../schemas/party.schema.js';

export class CancelQueuedPartyParamsDto {
  @ApiProperty({
    example: '68b700000000000000000001',
    description: 'Stable party identifier',
  })
  @IsMongoId()
  partyId: string;
}

export class CancelQueuedPartyResponseDto {
  @ApiProperty({ example: '68b700000000000000000001' })
  partyId: string;

  @ApiProperty({ example: 100 })
  queueNumber: number;

  @ApiProperty({ example: 6 })
  originalHeadcount: number;

  @ApiProperty({ example: 2 })
  cancelledNow: number;

  @ApiProperty({ example: 2 })
  cancelledCount: number;

  @ApiProperty({ example: 4 })
  seatedCount: number;

  @ApiProperty({ example: 0 })
  queuedCount: number;

  @ApiProperty({ example: 0 })
  departedCount: number;

  @ApiProperty({ enum: PartyStatus, example: PartyStatus.SEATED })
  status: PartyStatus;

  @ApiProperty({
    example: null,
    nullable: true,
    description:
      'Set only when no seated or queued guests remain after cancellation',
  })
  completedAt: Date | null;

  @ApiProperty({
    example: false,
    description: 'Cancellation never processes the next queued party',
  })
  queueReprocessed: false;
}
