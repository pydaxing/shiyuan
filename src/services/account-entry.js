import { ref } from 'vue';
import { createAccountEntry } from './account-entry-state.js';
let request;
export function configureAccountEntryRequest(value) { request = value; }
export const accountEntryStatus = ref({ phase: 'checking', busy: false, error: '' });
export const accountEntry = createAccountEntry({
  request: (action, payload) => request(action, payload),
  changed: value => { accountEntryStatus.value = value; },
});
