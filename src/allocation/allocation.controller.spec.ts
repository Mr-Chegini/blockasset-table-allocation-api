import { AllocationController } from './allocation.controller.js';
import { AllocationService } from './allocation.service.js';

describe('AllocationController', () => {
  it('delegates a customer allocation request to the service', async () => {
    const allocationService = {
      allocate: vi.fn().mockResolvedValue({ partyId: 'party-id' }),
    };
    const controller = new AllocationController(
      allocationService as unknown as AllocationService,
    );
    const dto = { headcount: 6 };

    await expect(controller.create(dto)).resolves.toEqual({
      partyId: 'party-id',
    });
    expect(allocationService.allocate).toHaveBeenCalledWith(dto);
  });
});
