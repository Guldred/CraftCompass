/** Returns the indexes of repeated keys after their first occurrence. */
export const duplicateIndexesBy = <Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string,
): number[] => {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      duplicates.push(index);
    } else {
      seen.add(key);
    }
  });
  return duplicates;
};
