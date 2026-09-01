import { RestaurantController } from './restaurant.controller.js';
import { RestaurantService } from './restaurant.service.js';

describe('RestaurantController', () => {
  const restaurantService = {
    configure: vi.fn(),
    getTables: vi.fn(),
  };
  const controller = new RestaurantController(
    restaurantService as unknown as RestaurantService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates restaurant configuration to the service', async () => {
    const dto = { tableCount: 5, chairsPerTable: 4 };
    restaurantService.configure.mockResolvedValue({ generatedTables: 5 });

    await expect(controller.configure(dto)).resolves.toEqual({
      generatedTables: 5,
    });
    expect(restaurantService.configure).toHaveBeenCalledWith(dto);
  });

  it('delegates table-state queries to the service', async () => {
    const state = {
      counts: { total: 0, free: 0, partial: 0, occupied: 0 },
      tables: [],
    };
    restaurantService.getTables.mockResolvedValue(state);

    await expect(controller.getTables()).resolves.toEqual(state);
    expect(restaurantService.getTables).toHaveBeenCalledOnce();
  });
});
