export const isPendingRecord = id => typeof id === 'string' && /^(?:set:)?pending-/.test(id);

export async function presentMutation(operation, accepted) {
  const immediate = operation?.accepted === true;
  if (immediate) accepted();
  const result = await operation;
  if (!immediate) accepted();
  return result;
}
