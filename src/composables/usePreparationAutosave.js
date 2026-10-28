import { state, cloudStatus, saveDishPreparation, retryCommand, discardCommand, commandQueueStatus } from '../store.js';
import { createPreparationAutosave } from './preparation-autosave.js';

let coordinator;

export function usePreparationAutosave() {
  if (!coordinator) coordinator = createPreparationAutosave({
    getState: () => state.value,
    getScope: () => `${state.value.family.id || ''}:${state.value.activeMemberId}`,
    isBusy: () => cloudStatus.value.busy,
    send: (...args) => saveDishPreparation(...args),
    retryOperation: operationId => retryCommand(operationId),
    discardOperation: operationId => discardCommand(operationId),
    getOperations: () => commandQueueStatus.value.operations,
  });
  return coordinator;
}
