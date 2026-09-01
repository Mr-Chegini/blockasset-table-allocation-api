import { AllocationService } from './allocation.service.js';
import { TableReleaseController } from './table-release.controller.js';

describe('TableReleaseController', () => {
  it('delegates table release to the allocation service', async () => {
    const allocationService = {
      releaseTable: vi.fn().mockResolvedValue({
        table: { code: 'T1', status: 'free' },
      }),
    };
    const controller = new TableReleaseController(
      allocationService as unknown as AllocationService,
    );

    await expect(controller.release('T1')).resolves.toEqual({
      table: { code: 'T1', status: 'free' },
    });
    expect(allocationService.releaseTable).toHaveBeenCalledWith('T1');
  });
});
