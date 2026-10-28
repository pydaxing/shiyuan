import { state, cloudStatus, cloudMode } from '../store.js';
import { invokeCloud } from './cloud.js';
import { createPreparedInvitation, familyInvitationContext } from './prepared-invitation.js';

export const familyInvitation = createPreparedInvitation({
  getContext: () => cloudMode ? familyInvitationContext(state.value, cloudStatus.value) : null,
  request: payload => invokeCloud('prepareInvite', payload),
});
