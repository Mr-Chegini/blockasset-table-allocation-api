import { AvailableTable, selectTables } from './table-selector.js';

function table(tableNumber: number, capacity: number): AvailableTable {
  return {
    id: `id-${tableNumber}`,
    code: `T${tableNumber}`,
    tableNumber,
    capacity,
  };
}

describe('selectTables', () => {
  it('selects one table for an exact fit', () => {
    const result = selectTables(4, [table(1, 4), table(2, 4)]);

    expect(result).toEqual({
      selectedTables: [table(1, 4)],
      selectedCapacity: 4,
      seatedCount: 4,
      unseatedCount: 0,
      unusedSeats: 0,
    });
  });

  it('prioritizes fewer tables over an exact fit using more tables', () => {
    const result = selectTables(8, [table(1, 10), table(2, 4), table(3, 4)]);

    expect(result.selectedTables).toEqual([table(1, 10)]);
    expect(result.unusedSeats).toBe(2);
  });

  it('chooses the least unused capacity among equal table counts', () => {
    const result = selectTables(9, [table(1, 6), table(2, 5), table(3, 4)]);

    expect(result.selectedTables).toEqual([table(2, 5), table(3, 4)]);
    expect(result.unusedSeats).toBe(0);
  });

  it('uses table number as a deterministic final tie-break', () => {
    const result = selectTables(6, [table(3, 4), table(1, 4), table(2, 4)]);

    expect(result.selectedTables).toEqual([table(1, 4), table(2, 4)]);
  });

  it('selects every table when only part of the party can be seated', () => {
    const result = selectTables(11, [table(2, 4), table(1, 4)]);

    expect(result).toEqual({
      selectedTables: [table(1, 4), table(2, 4)],
      selectedCapacity: 8,
      seatedCount: 8,
      unseatedCount: 3,
      unusedSeats: 0,
    });
  });

  it('queues the whole party when no table is available', () => {
    expect(selectTables(3, [])).toEqual({
      selectedTables: [],
      selectedCapacity: 0,
      seatedCount: 0,
      unseatedCount: 3,
      unusedSeats: 0,
    });
  });

  it('does not mutate the supplied table order', () => {
    const tables = [table(2, 4), table(1, 4)];

    selectTables(4, tables);

    expect(tables.map(({ code }) => code)).toEqual(['T2', 'T1']);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid headcount %s',
    (headcount) => {
      expect(() => selectTables(headcount, [table(1, 4)])).toThrow(RangeError);
    },
  );

  it('rejects an invalid table capacity', () => {
    expect(() => selectTables(2, [table(1, 0)])).toThrow(RangeError);
  });
});
