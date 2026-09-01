import { AllocationService } from './allocation.service.js';
import { QueueProcessingController } from './queue-processing.controller.js';

describe('QueueProcessingController', () => {
  it('delegates FIFO queue processing to the allocation service', async () => {
    const allocationService = {
      processQueue: vi.fn().mockResolvedValue({
        outcome: 'queue_empty',
        processedCount: 0,
      }),
    };
    const controller = new QueueProcessingController(
      allocationService as unknown as AllocationService,
    );

    await expect(controller.process()).resolves.toEqual({
      outcome: 'queue_empty',
      processedCount: 0,
    });
    expect(allocationService.processQueue).toHaveBeenCalledOnce();
  });
});
