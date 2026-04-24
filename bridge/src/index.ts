/**
 * Filenymous Bridge — relay WebSocket + email notification
 *
 * Endpoints publics (pas d'auth) :
 *   WS  /relay/:sessionId  — broker P2P entre expéditeur et destinataire
 *   POST /send-email        — envoie le lien de téléchargement par email
 *
 * Endpoints internes (HMAC) :
 *   POST /notify/email
 *   POST /notify/sms
 *   POST /otp/send
 *   POST /otp/verify
 *
 * Aucune donnée persistée — stateless au-delà de la connexion WS active.
 */

import "dotenv/config";
import Fastify              from "fastify";
import cors                 from "@fastify/cors";
import fwsPlugin            from "@fastify/websocket";
import { z }                from "zod";
import type { WebSocket }   from "ws";
import { sendEmail }        from "./notify.js";
import { createOtp, verifyOtp } from "./otp.js";
import { verifyHmac }       from "./auth.js";

const PORT = parseInt(process.env.PORT ?? "3001");
const HOST = process.env.HOST ?? "0.0.0.0";

// ── Relay sessions (in-memory, éphémères) ────────────────────────────────────
// Map<sessionId, [senderSocket, receiverSocket?]>
const sessions = new Map<string, WebSocket[]>();

// ── App ───────────────────────────────────────────────────────────────────────
const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(fwsPlugin);

// ── HMAC auth — exclure les routes publiques ──────────────────────────────────
const PUBLIC_PATHS = ["/health", "/send-email"];

app.addHook("preHandler", async (req, reply) => {
  if (PUBLIC_PATHS.includes(req.url)) return;
  if (req.url.startsWith("/relay/"))   return;

  const sig  = req.headers["x-bridge-sig"] as string | undefined;
  const body = JSON.stringify(req.body ?? {});
  if (!sig || !verifyHmac(body, sig)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async () => ({ ok: true, ts: Date.now() }));

// ── WebSocket relay ───────────────────────────────────────────────────────────
//
// Protocole :
//   1. Expéditeur se connecte → reçoit { type: "waiting" }
//   2. Destinataire se connecte → les deux reçoivent { type: "connected" }
//   3. Chaque message/frame binaire est relayé à l'autre pair
//   4. À la déconnexion → l'autre pair reçoit { type: "disconnected" }
//
app.get("/relay/:sessionId", { websocket: true }, (socket: WebSocket, req) => {
  const { sessionId } = req.params as { sessionId: string };

  const peers = sessions.get(sessionId) ?? [];

  if (peers.length >= 2) {
    // Session pleine — refuser
    socket.send(JSON.stringify({ type: "error", message: "Session full" }));
    socket.close();
    return;
  }

  peers.push(socket);
  sessions.set(sessionId, peers);

  app.log.info({ sessionId, peers: peers.length }, "relay: peer joined");

  if (peers.length === 1) {
    socket.send(JSON.stringify({ type: "waiting" }));
  } else {
    // Deux pairs présents — démarrer le relay
    peers[0].send(JSON.stringify({ type: "connected" }));
    peers[1].send(JSON.stringify({ type: "connected" }));
  }

  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    const other = peers.find(p => p !== socket);
    if (other && other.readyState === 1 /* OPEN */) {
      other.send(data, { binary: isBinary });
    }
  });

  socket.on("close", () => {
    app.log.info({ sessionId }, "relay: peer left");
    const other = peers.find(p => p !== socket);
    if (other && other.readyState === 1) {
      other.send(JSON.stringify({ type: "disconnected" }));
    }
    sessions.delete(sessionId);
  });

  socket.on("error", (err) => {
    app.log.warn({ sessionId, err: err.message }, "relay: socket error");
    sessions.delete(sessionId);
  });
});

// ── POST /send-email (public — appelé depuis le navigateur) ───────────────────
const SendEmailSchema = z.object({
  to:            z.string().email(),
  from_name:     z.string().max(120),
  from_contact:  z.string().max(200).optional().default(""),
  file_names:    z.string().max(500).optional().default("—"),
  transfer_link: z.string().url(),
  lang:          z.enum(["fr", "en", "es", "ko"]).optional().default("fr"),
});

app.post("/send-email", async (req, reply) => {
  const result = SendEmailSchema.safeParse(req.body);
  if (!result.success) {
    return reply.code(400).send({ ok: false, message: "Payload invalide" });
  }
  const { to, from_name, from_contact, file_names, transfer_link, lang } = result.data;
  try {
    await sendEmail({ to, fromName: from_name, fromContact: from_contact, fileNames: file_names, link: transfer_link, lang });
    return { ok: true };
  } catch (err: any) {
    app.log.error(err, "send-email failed");
    return reply.code(500).send({ ok: false, message: err?.message ?? "Erreur envoi" });
  }
});

// ── POST /notify/email (interne — HMAC requis) ────────────────────────────────
const NotifySchema = z.object({
  contact: z.string().min(3),
  link:    z.string().url(),
  message: z.string().max(500).optional().default(""),
});

app.post("/notify/email", async (req, reply) => {
  const result = NotifySchema.safeParse(req.body);
  if (!result.success) return reply.code(400).send(result.error);
  const { contact, link, message } = result.data;
  await sendEmail({ to: contact, fromName: "Filenymous", fromContact: "", fileNames: "—", link, lang: "fr" });
  return { ok: true };
});

// ── OTP ───────────────────────────────────────────────────────────────────────
const OtpSendSchema = z.object({ contact: z.string().min(3) });
app.post("/otp/send", async (req, reply) => {
  const result = OtpSendSchema.safeParse(req.body);
  if (!result.success) return reply.code(400).send(result.error);
  await createOtp(result.data.contact);
  return { ok: true };
});

const OtpVerifySchema = z.object({
  contact: z.string().min(3),
  code:    z.string().length(6),
});
app.post("/otp/verify", async (req, reply) => {
  const result = OtpVerifySchema.safeParse(req.body);
  if (!result.success) return reply.code(400).send(result.error);
  const valid = verifyOtp(result.data.contact, result.data.code);
  if (!valid) return reply.code(401).send({ error: "Code invalide ou expiré" });
  return { ok: true };
});

// ── Start ─────────────────────────────────────────────────────────────────────
await app.listen({ port: PORT, host: HOST });
app.log.info(`Bridge listening on ${HOST}:${PORT}`);
