import type { AgentPubKey, ActionHash } from "@holochain/client";
import { callZome } from "./client";

export const identityZome = {
  /** Publish a ContactClaim on the DHT after OTP verification */
  claimContact(contact_hash: string): Promise<ActionHash> {
    return callZome("identity", "claim_contact", { contact_hash });
  },

  /** Resolve a contact hash to an AgentPubKey — null if not found */
  getAgentForContact(contact_hash: string): Promise<AgentPubKey | null> {
    return callZome("identity", "get_agent_for_contact", contact_hash);
  },

  /** Delete this agent's ContactClaim from the DHT (RGPD erasure) */
  revokeContactClaim(contact_hash: string): Promise<ActionHash> {
    return callZome("identity", "revoke_contact_claim", contact_hash);
  },
};
