import type { ActionHash } from "@holochain/client";
import { callZome } from "./client";
import type {
  CreateTransferInput,
  GetTransferOutput,
  RecordDownloadInput,
} from "./types";

export const transferZome = {
  createTransfer(input: CreateTransferInput): Promise<ActionHash> {
    return callZome("transfer", "create_transfer", input);
  },

  getTransfer(transfer_id: string): Promise<GetTransferOutput | null> {
    return callZome("transfer", "get_transfer", transfer_id);
  },

  getMySentTransfers(): Promise<GetTransferOutput[]> {
    return callZome("transfer", "get_my_sent_transfers", null);
  },

  getTransfersForContact(contact_hash: string): Promise<GetTransferOutput[]> {
    return callZome("transfer", "get_transfers_for_contact", contact_hash);
  },

  recordDownload(input: RecordDownloadInput): Promise<ActionHash> {
    return callZome("transfer", "record_download", input);
  },

  revokeTransfer(transfer_id: string): Promise<ActionHash> {
    return callZome("transfer", "revoke_transfer", transfer_id);
  },

  expireTransfer(transfer_id: string): Promise<ActionHash> {
    return callZome("transfer", "expire_transfer", transfer_id);
  },
};
