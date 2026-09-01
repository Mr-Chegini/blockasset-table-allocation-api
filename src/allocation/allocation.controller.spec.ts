import { AllocationController } from './allocation.controller.js';
import { AllocationService } from './allocation.service.js';

describe('AllocationController', () => {
  const allocationService = {
    allocate: vi.fn(),
    getQueue: vi.fn(),
  };
  const controller = new AllocationController(
    allocationService as unknown as AllocationService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates a customer allocation request to the service', async () => {
    allocationService.allocate.mockResolvedValue({ partyId: 'party-id' });
    const dto = { headcount: 6 };

    await expect(controller.create(dto)).resolves.toEqual({
      partyId: 'party-id',
    });
    expect(allocationService.allocate).toHaveBeenCalledWith(dto);
  });

  it('delegates queue queries to the service', async () => {
    allocationService.getQueue.mockResolvedValue({ count: 0, entries: [] });

    await expect(controller.getQueue()).resolves.toEqual({
      count: 0,
      entries: [],
    });
    expect(allocationService.getQueue).toHaveBeenCalledOnce();
  });
});
