export interface AvailableTable {
  id: string;
  code: string;
  tableNumber: number;
  capacity: number;
}

export interface TableSelection {
  selectedTables: AvailableTable[];
  selectedCapacity: number;
  seatedCount: number;
  unseatedCount: number;
  unusedSeats: number;
}

/**
 * Selects tables using the business-rule ordering:
 *
 * 1. Seat the full party when enough total capacity is available.
 * 2. Use the fewest tables.
 * 3. Among selections of that size, leave the fewest seats unused.
 * 4. Use the lowest table numbers as a deterministic final tie-break.
 *
 * The dynamic-programming state stores one deterministic combination for each
 * attainable capacity and table count. Although the configured restaurant has
 * uniform capacities, keeping this function capacity-aware makes the rule
 * explicit and independently testable.
 */
export function selectTables(
  headcount: number,
  availableTables: readonly AvailableTable[],
): TableSelection {
  assertValidInput(headcount, availableTables);

  const tables = [...availableTables].sort(compareTables);
  const totalCapacity = tables.reduce(
    (total, table) => total + table.capacity,
    0,
  );

  if (totalCapacity < headcount) {
    return {
      selectedTables: tables,
      selectedCapacity: totalCapacity,
      seatedCount: totalCapacity,
      unseatedCount: headcount - totalCapacity,
      unusedSeats: 0,
    };
  }

  const combinationsByCount = Array.from(
    { length: tables.length + 1 },
    () => new Map<number, number[]>(),
  );
  combinationsByCount[0].set(0, []);

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    for (let tableCount = tableIndex + 1; tableCount >= 1; tableCount -= 1) {
      for (const [capacity, indices] of combinationsByCount[tableCount - 1]) {
        const nextCapacity = capacity + tables[tableIndex].capacity;
        const nextIndices = [...indices, tableIndex];
        const currentIndices =
          combinationsByCount[tableCount].get(nextCapacity);

        if (
          currentIndices === undefined ||
          isLexicographicallyEarlier(nextIndices, currentIndices)
        ) {
          combinationsByCount[tableCount].set(nextCapacity, nextIndices);
        }
      }
    }
  }

  for (let tableCount = 1; tableCount <= tables.length; tableCount += 1) {
    let bestCapacity = Number.POSITIVE_INFINITY;
    let bestIndices: number[] | undefined;

    for (const [capacity, indices] of combinationsByCount[tableCount]) {
      if (capacity >= headcount && capacity < bestCapacity) {
        bestCapacity = capacity;
        bestIndices = indices;
      }
    }

    if (bestIndices !== undefined) {
      return {
        selectedTables: bestIndices.map((index) => tables[index]),
        selectedCapacity: bestCapacity,
        seatedCount: headcount,
        unseatedCount: 0,
        unusedSeats: bestCapacity - headcount,
      };
    }
  }

  throw new Error('Unable to select tables despite sufficient total capacity');
}

function assertValidInput(
  headcount: number,
  availableTables: readonly AvailableTable[],
): void {
  if (!Number.isSafeInteger(headcount) || headcount <= 0) {
    throw new RangeError('Headcount must be a positive safe integer');
  }

  for (const table of availableTables) {
    if (!Number.isSafeInteger(table.capacity) || table.capacity <= 0) {
      throw new RangeError(`Table ${table.code} must have a positive capacity`);
    }
  }
}

function compareTables(left: AvailableTable, right: AvailableTable): number {
  return (
    left.tableNumber - right.tableNumber || left.code.localeCompare(right.code)
  );
}

function isLexicographicallyEarlier(
  candidate: readonly number[],
  current: readonly number[],
): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== current[index]) {
      return candidate[index] < current[index];
    }
  }

  return false;
}
