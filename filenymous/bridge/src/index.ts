/**
 * Filenymous Bridge — micro-service de notification
 *
 * Rôle : envoyer emails et SMS pour notifier les destinataires.
 * Ne stocke AUCUN fichier, AUCUNE clé, AUCUNE donnée utilisateur au-delà
 * du temps de traitement de la requête (TTL : 0, aucune persistence).
 *
 * Auth : chaque requête doit porter un header X-Bridge-Sig contenant
 * un HMAC-SHA256 du body signé avec BRIDGE_SECRET (partagé avec le conductor).
 */

import "dotenv/config";
import Fastify from "fastify";
import cors    from "@fastify/cors";
import { z }   from "zod";
import { sendEmail, sendSms }  from "./notify.js";
import { createOtp, verifyOtp } from "./otp.js";
import { verifyHmac }           from "./auth.js";

const PORT   = parseInt(process.env.PORT ?? "3001");
const HOST   = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: true });

// ── HMAC auth hook ────────────────────────────────────────────────────────
app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;
  const sig  = req.headers["x-bridge-sig"] as string | undefined;
  const body = JSON.stringify(req.body);
  if (!sig || !verifyHmac(body, sig)) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, ts: Date.now() }));

// Send notification (email or SMS) to the recipient
const NotifySchema = z.object({
  contact: z.string().min(3),
  link:    z.string().url(),
  message: z.string().max(500).optional(),
});

app.post("/notify/email", async (req, reply) => {
  const body = NotifySchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send(body.error);
  await sendEmail(body.data.contact, body.data.link, body.data.message ?? "");
  return { ok: true };
});

app.post("/notify/sms", async (req, reply) => {
  const body = NotifySchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send(body.error);
  await sendSms(body.data.contact, body.data.link, body.data.message ?? "");
  return { ok: true };
});

// OTP: send a 6-digit code to verify ownership of a contact
const OtpSendSchema = z.object({ contact: z.string().min(3) });
app.post("/otp/send", async (req, reply) => {
  const body = OtpSendSchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send(body.error);
  await createOtp(body.data.contact);
  return { ok: true };
});

// OTP: verify the code — returns 200 on success, 401 on failure
const OtpVerifySchema = z.object({
  contact: z.string().min(3),
  code:    z.string().length(6),
});
app.post("/otp/verify", async (req, reply) => {
  const body = OtpVerifySchema.safeParse(req.body);
  if (!body.success) return reply.code(400).send(body.error);
  const valid = verifyOtp(body.data.contact, body.data.code);
  if (!valid) return reply.code(401).send({ error: "Invalid or expired OTP" });
  return { ok: true };
});

// ── Start ─────────────────────────────────────────────────────────────────
await app.listen({ port: PORT, host: HOST });
app.log.info(`Bridge listening on ${HOST}:${PORT}`);
