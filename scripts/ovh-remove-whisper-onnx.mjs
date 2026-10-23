#!/usr/bin/env node
// Delete only the two Whisper ONNX weights from app/models on OVH (frees quota;
// captions then report "unavailable"). Prints sizes, never secrets.
import SftpClient from "ssh2-sftp-client";
const base = "/home/filenyb/www/app/models/Xenova/whisper-tiny/onnx";
const files = ["encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx"];
const c = new SftpClient("filenymous-models");
await c.connect({ host: "ftp.cluster129.hosting.ovh.net", port: 22, username: "filenyb", password: process.env.OVH_SFTP_PASS });
let freed = 0;
try {
  for (const f of files) {
    const p = `${base}/${f}`;
    const st = await c.stat(p).catch(() => null);
    if (!st) { console.log(`absent  ${f}`); continue; }
    await c.delete(p);
    freed += st.size;
    console.log(`deleted ${f}  ${st.size} bytes`);
  }
  console.log(`freed ${(freed / 1e6).toFixed(1)} MB`);
} finally { await c.end(); }
