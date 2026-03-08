const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const dotenv = require('dotenv');
const pino = require('pino');

dotenv.config();

const port = Number(process.env.PORT || 3001);
const authToken = (process.env.AUTH_TOKEN || '').trim();
const sessionPath = (process.env.WHATSAPP_SESSION_PATH || '.baileys_auth').trim();
const confirmationStorePath = (process.env.CONFIRMATION_STORE_PATH || '.confirmation_store.json').trim();
const reminderMinutesBeforeEnv = Number(process.env.CONFIRMATION_REMINDER_MINUTES || 30);
const reminderMinutesBefore = Number.isFinite(reminderMinutesBeforeEnv) && reminderMinutesBeforeEnv > 0
  ? Math.floor(reminderMinutesBeforeEnv)
  : 30;
const reminderScanIntervalMs = Math.max(5000, Number(process.env.CONFIRMATION_SCAN_INTERVAL_MS || 30000));
const staleCleanupHours = Math.max(24, Number(process.env.CONFIRMATION_CLEANUP_HOURS || 72));
const defaultCancelUrlTemplate = (process.env.CONFIRMATION_CANCEL_URL_TEMPLATE || '').trim();
const defaultCancelMethod = (process.env.CONFIRMATION_CANCEL_METHOD || 'DELETE').trim().toUpperCase();
const defaultCancelToken = (process.env.CONFIRMATION_CANCEL_TOKEN || '').trim();
const defaultCancelTokenHeader = (process.env.CONFIRMATION_CANCEL_TOKEN_HEADER || 'Authorization').trim();
const defaultCancelTokenPrefix = (process.env.CONFIRMATION_CANCEL_TOKEN_PREFIX || 'Bearer').trim();
const cancelRequestTimeoutMs = Math.max(1000, Number(process.env.CONFIRMATION_CANCEL_TIMEOUT_MS || 10000));
const maintenanceDaysAfter = Math.max(1, Number(process.env.MAINTENANCE_FOLLOWUP_DAYS || 15));
const corsAllowedOriginsRaw = (process.env.CORS_ALLOWED_ORIGINS || '*').trim();
const corsAllowedOrigins = corsAllowedOriginsRaw === '*'
  ? ['*']
  : corsAllowedOriginsRaw.split(',').map((origin) => origin.trim()).filter(Boolean);

const app = express();
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');

  if (corsAllowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && corsAllowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
});
app.use(express.json({ limit: '1mb' }));

/** @type {Map<string, { socket: any|null, ready: boolean, startupError: string|null, lastQr: string|null, connecting: boolean, authPath: string|null }>} */
const companySessions = new Map();
/** @type {Map<string, any>} */
const confirmationEntries = new Map();

function ensureDirForFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return absolutePath;
}

function readJsonFile(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallbackValue;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[CONFIRMATION] Falha ao ler arquivo ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return fallbackValue;
  }
}

function writeJsonFile(filePath, payload) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.warn(`[CONFIRMATION] Falha ao salvar arquivo ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildConfirmationKey(companyId, appointmentId) {
  return `${normalizeCompanyId(companyId)}:${String(appointmentId || '').trim()}`;
}

function toIsoDate(dateInput) {
  const parsed = new Date(dateInput);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString();
}

function resolveStartAtInput(payload) {
  const startAtRaw = String(payload?.startAt || payload?.start_at || '').trim();
  if (startAtRaw) {
    return startAtRaw;
  }

  const dateRaw = String(payload?.date || payload?.startDate || payload?.start_date || '').trim();
  const timeRaw = String(payload?.time || payload?.startTime || payload?.start_time || '').trim();

  if (!dateRaw || !timeRaw) {
    return '';
  }

  // Accept "HH:mm" and "HH:mm:ss" and build a full datetime from sent date + time.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw) || !/^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw)) {
    return '';
  }

  const normalizedTime = timeRaw.length === 5 ? `${timeRaw}:00` : timeRaw;
  return `${dateRaw}T${normalizedTime}`;
}

function formatDateTimeForMessage(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return { date: 'data informada', time: 'horário informado' };
  }

  const formattedDate = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);

  const formattedTime = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return {
    date: formattedDate,
    time: formattedTime,
  };
}

function buildReminderMessage(entry) {
  const { date, time } = formatDateTimeForMessage(entry.startAt);
  const clientName = String(entry.clientName || '').trim();

  return [
    `Olá ${clientName || 'cliente'}!`,
    `Seu agendamento está marcado para ${date} às ${time}.`,
    'Confirme sua presença respondendo:',
    '1 - Vou comparecer',
    '2 - Não vou comparecer (cancelar agendamento)',
  ].join('\n');
}

function buildMaintenanceMessage(entry) {
  const clientName = String(entry.clientName || '').trim();

  return [
    `Olá ${clientName || 'cliente'}!`,
    'Já se passaram alguns dias desde o seu atendimento.',
    'Está na hora de fazer a manutenção do serviço.',
    'Se quiser, responda esta mensagem para agendarmos seu retorno.',
  ].join('\n');
}

function persistConfirmations() {
  const storePath = ensureDirForFile(confirmationStorePath);
  writeJsonFile(storePath, Array.from(confirmationEntries.values()));
}

function loadConfirmations() {
  const storePath = ensureDirForFile(confirmationStorePath);
  const loaded = readJsonFile(storePath, []);
  if (!Array.isArray(loaded)) {
    return;
  }

  for (const rawEntry of loaded) {
    const companyId = normalizeCompanyId(rawEntry?.companyId || '');
    const appointmentId = String(rawEntry?.appointmentId || '').trim();
    const number = normalizePhone(rawEntry?.number || '');
    const startAt = toIsoDate(rawEntry?.startAt || '');

    if (!companyId || !appointmentId || !number || !startAt) {
      continue;
    }

    const key = buildConfirmationKey(companyId, appointmentId);
    confirmationEntries.set(key, {
      key,
      companyId,
      appointmentId,
      number,
      clientName: String(rawEntry?.clientName || '').trim(),
      startAt,
      status: String(rawEntry?.status || 'scheduled').trim() || 'scheduled',
      reminderSentAt: rawEntry?.reminderSentAt ? toIsoDate(rawEntry.reminderSentAt) : null,
      response: rawEntry?.response ? String(rawEntry.response).trim() : null,
      responseAt: rawEntry?.responseAt ? toIsoDate(rawEntry.responseAt) : null,
      cancelUrl: rawEntry?.cancelUrl ? String(rawEntry.cancelUrl).trim() : '',
      cancelMethod: rawEntry?.cancelMethod ? String(rawEntry.cancelMethod).trim().toUpperCase() : '',
      cancelHeaders: rawEntry?.cancelHeaders && typeof rawEntry.cancelHeaders === 'object' ? rawEntry.cancelHeaders : {},
      cancelBody: rawEntry?.cancelBody ?? null,
      cancelResult: rawEntry?.cancelResult && typeof rawEntry.cancelResult === 'object' ? rawEntry.cancelResult : null,
      maintenanceAt: rawEntry?.maintenanceAt ? toIsoDate(rawEntry.maintenanceAt) : null,
      maintenanceStatus: String(rawEntry?.maintenanceStatus || 'pending').trim() || 'pending',
      maintenanceSentAt: rawEntry?.maintenanceSentAt ? toIsoDate(rawEntry.maintenanceSentAt) : null,
      createdAt: rawEntry?.createdAt ? toIsoDate(rawEntry.createdAt) : new Date().toISOString(),
      updatedAt: rawEntry?.updatedAt ? toIsoDate(rawEntry.updatedAt) : new Date().toISOString(),
    });
  }
}

function upsertConfirmation(entry) {
  confirmationEntries.set(entry.key, {
    ...entry,
    updatedAt: new Date().toISOString(),
  });
  persistConfirmations();
}

function resolveCancelRequest(entry) {
  const method = (entry.cancelMethod || defaultCancelMethod || 'DELETE').toUpperCase();
  const template = entry.cancelUrl || defaultCancelUrlTemplate;
  const appointmentId = String(entry.appointmentId || '').trim();
  const url = template.includes('{id}') ? template.replace('{id}', encodeURIComponent(appointmentId)) : template;

  const headers = {
    ...(entry.cancelHeaders || {}),
  };

  if (defaultCancelToken) {
    headers[defaultCancelTokenHeader] = defaultCancelTokenPrefix
      ? `${defaultCancelTokenPrefix} ${defaultCancelToken}`
      : defaultCancelToken;
  }

  const init = {
    method,
    headers,
  };

  if (entry.cancelBody !== null && entry.cancelBody !== undefined) {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    init.body = typeof entry.cancelBody === 'string' ? entry.cancelBody : JSON.stringify(entry.cancelBody);
  }

  return {
    url,
    init,
  };
}

async function cancelAppointmentByEntry(entry) {
  const request = resolveCancelRequest(entry);
  if (!request.url) {
    return {
      ok: false,
      status: 0,
      body: 'CONFIRMATION_CANCEL_URL_TEMPLATE não configurado',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cancelRequestTimeoutMs);

    const response = await fetch(request.url, {
      ...request.init,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const rawBody = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      body: rawBody,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseIncomingText(message) {
  const conversation = message?.message?.conversation;
  if (conversation && typeof conversation === 'string') {
    return conversation.trim();
  }

  const extended = message?.message?.extendedTextMessage?.text;
  if (extended && typeof extended === 'string') {
    return extended.trim();
  }

  const imageCaption = message?.message?.imageMessage?.caption;
  if (imageCaption && typeof imageCaption === 'string') {
    return imageCaption.trim();
  }

  return '';
}

function findPendingEntryForReply(companyId, number) {
  const companyKey = normalizeCompanyId(companyId);
  const normalizedNumber = normalizePhone(number);
  const nowTs = Date.now();
  const candidates = Array.from(confirmationEntries.values())
    .filter((entry) => entry.companyId === companyKey)
    .filter((entry) => normalizePhone(entry.number) === normalizedNumber)
    .filter((entry) => entry.status === 'sent')
    .filter((entry) => new Date(entry.startAt).getTime() >= nowTs - (24 * 60 * 60 * 1000))
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  return candidates[0] || null;
}

async function handleIncomingMessage(companyId, message) {
  const remoteJid = String(message?.key?.remoteJid || '').trim();
  if (!remoteJid || remoteJid.endsWith('@g.us')) {
    return;
  }

  const isFromMe = Boolean(message?.key?.fromMe);
  if (isFromMe) {
    return;
  }

  const incomingText = parseIncomingText(message);
  if (!incomingText) {
    return;
  }

  const normalizedReply = incomingText.replace(/\s+/g, '').trim();
  if (normalizedReply !== '1' && normalizedReply !== '2') {
    return;
  }

  const number = normalizePhone(remoteJid.split('@')[0] || '');
  const entry = findPendingEntryForReply(companyId, number);
  if (!entry) {
    return;
  }

  entry.response = normalizedReply;
  entry.responseAt = new Date().toISOString();

  if (normalizedReply === '1') {
    entry.status = 'confirmed';
    upsertConfirmation(entry);
    await sendTextByCompany(companyId, number, 'Perfeito! Presença confirmada. Obrigado!');
    return;
  }

  const cancelResult = await cancelAppointmentByEntry(entry);
  entry.cancelResult = cancelResult;

  if (cancelResult.ok) {
    entry.status = 'cancelled';
    entry.maintenanceStatus = 'skipped_cancelled';
    upsertConfirmation(entry);
    await sendTextByCompany(companyId, number, 'Seu agendamento foi cancelado com sucesso.');
    return;
  }

  entry.status = 'cancel_error';
  upsertConfirmation(entry);
  await sendTextByCompany(
    companyId,
    number,
    'Recebi seu pedido de cancelamento, mas não consegui concluir automaticamente. Entre em contato com a empresa para confirmar o cancelamento.'
  );
}

async function dispatchDueReminders() {
  const nowTs = Date.now();

  for (const entry of confirmationEntries.values()) {
    if (entry.status !== 'scheduled') {
      continue;
    }

    const startTs = new Date(entry.startAt).getTime();
    if (Number.isNaN(startTs)) {
      continue;
    }

    const sendAtTs = startTs - (reminderMinutesBefore * 60 * 1000);
    if (nowTs < sendAtTs) {
      continue;
    }

    if (nowTs >= startTs) {
      continue;
    }

    const message = buildReminderMessage(entry);
    const sendResult = await sendTextByCompany(entry.companyId, entry.number, message);
    if (sendResult.status === 200) {
      entry.status = 'sent';
      entry.reminderSentAt = new Date().toISOString();
      upsertConfirmation(entry);
      continue;
    }

    entry.status = 'scheduled';
    upsertConfirmation(entry);
  }

  for (const entry of confirmationEntries.values()) {
    if (entry.maintenanceStatus !== 'pending') {
      continue;
    }

    const maintenanceTs = new Date(entry.maintenanceAt).getTime();
    if (Number.isNaN(maintenanceTs)) {
      continue;
    }

    if (nowTs < maintenanceTs) {
      continue;
    }

    const message = buildMaintenanceMessage(entry);
    const sendResult = await sendTextByCompany(entry.companyId, entry.number, message);
    if (sendResult.status === 200) {
      entry.maintenanceStatus = 'sent';
      entry.maintenanceSentAt = new Date().toISOString();
      upsertConfirmation(entry);
      continue;
    }

    entry.maintenanceStatus = 'pending';
    upsertConfirmation(entry);
  }

  const maxAgeMs = staleCleanupHours * 60 * 60 * 1000;
  let removed = 0;
  for (const [key, entry] of confirmationEntries.entries()) {
    const startTs = new Date(entry.startAt).getTime();
    const maintenanceTs = new Date(entry.maintenanceAt).getTime();
    if (Number.isNaN(startTs)) {
      confirmationEntries.delete(key);
      removed += 1;
      continue;
    }

    const hasValidMaintenanceAt = !Number.isNaN(maintenanceTs);
    const cleanupBaseTs = hasValidMaintenanceAt ? Math.max(startTs, maintenanceTs) : startTs;

    if (nowTs - cleanupBaseTs > maxAgeMs) {
      confirmationEntries.delete(key);
      removed += 1;
    }
  }

  if (removed > 0) {
    persistConfirmations();
  }
}

loadConfirmations();
setInterval(() => {
  dispatchDueReminders().catch((error) => {
    console.error(`[CONFIRMATION] Falha ao processar lembretes: ${error instanceof Error ? error.message : String(error)}`);
  });
}, reminderScanIntervalMs);

function normalizeCompanyId(companyId) {
  const normalized = String(companyId || '').replace(/\D+/g, '').trim();
  return normalized === '' ? '' : normalized;
}

function getOrCreateSession(companyId) {
  const key = normalizeCompanyId(companyId);
  if (!key) {
    return null;
  }

  if (!companySessions.has(key)) {
    companySessions.set(key, {
      socket: null,
      ready: false,
      startupError: null,
      lastQr: null,
      connecting: false,
      authPath: null,
    });
  }

  return companySessions.get(key);
}

async function initCompanySocket(companyId) {
  const key = normalizeCompanyId(companyId);
  const session = getOrCreateSession(key);
  if (!session) {
    return null;
  }

  if (session.connecting || session.ready) {
    return session;
  }

  session.connecting = true;
  session.startupError = null;

  try {
    const companySessionPath = `${sessionPath}/${key}`;
    session.authPath = companySessionPath;
    const { state, saveCreds } = await useMultiFileAuthState(companySessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: [`Agenda Pro ${key}`, 'Chrome', '1.0.0'],
    });

    session.socket = socket;

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('messages.upsert', async (event) => {
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      for (const incomingMessage of messages) {
        await handleIncomingMessage(key, incomingMessage);
      }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.lastQr = qr;
        console.log(`\n[WhatsApp][company:${key}] Escaneie o QR Code abaixo:\n`);
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        session.ready = true;
        session.connecting = false;
        session.startupError = null;
        session.lastQr = null;
        console.log(`[WhatsApp][company:${key}] Cliente conectado e pronto.`);
      }

      if (connection === 'close') {
        session.ready = false;
        session.connecting = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        session.startupError = `connection_closed:${statusCode ?? 'unknown'}`;
        console.warn(`[WhatsApp][company:${key}] Conexão encerrada. Código: ${statusCode ?? 'unknown'}`);

        if (!shouldReconnect) {
          if (session.authPath) {
            try {
              fs.rmSync(session.authPath, { recursive: true, force: true });
            } catch (error) {
              console.warn(`[WhatsApp][company:${key}] Falha ao limpar sessão: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          session.socket = null;
          session.lastQr = null;
          session.startupError = 'session_logged_out';
        }

        if (shouldReconnect) {
          await initCompanySocket(key);
        }
      }
    });

    return session;
  } catch (error) {
    session.ready = false;
    session.connecting = false;
    session.startupError = error instanceof Error ? error.message : String(error);
    console.error(`[WhatsApp][company:${key}] Falha ao inicializar: ${session.startupError}`);
    return session;
  }
}

function unauthorized(res) {
  return res.status(401).json({
    ok: false,
    message: 'Unauthorized',
  });
}

function normalizePhone(number) {
  const digits = String(number || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits;
}

function toWhatsAppJid(number) {
  const normalized = normalizePhone(number);
  if (!normalized) return '';
  return `${normalized}@s.whatsapp.net`;
}

function checkAuth(req, res, next) {
  if (!authToken) {
    return next();
  }

  const authHeader = String(req.header('Authorization') || '').trim();
  const expected = `Bearer ${authToken}`;

  if (authHeader !== expected) {
    return unauthorized(res);
  }

  return next();
}

function resolveCompanyId(req) {
  const pathCompanyId = normalizeCompanyId(req.params?.companyId || '');
  if (pathCompanyId !== '') {
    return pathCompanyId;
  }

  const bodyCompanyId = normalizeCompanyId(req.body?.companyId || req.body?.company_id || '');
  if (bodyCompanyId !== '') {
    return bodyCompanyId;
  }

  return '';
}

function validateCompanyId(companyId, res) {
  if (companyId !== '') {
    return true;
  }

  res.status(422).json({
    ok: false,
    message: 'Campo obrigatório: companyId',
  });
  return false;
}

async function waitForSessionReady(session, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (session.ready && session.socket) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return Boolean(session.ready && session.socket);
}

async function sendTextByCompany(companyId, number, text) {
  const session = getOrCreateSession(companyId);
  if (!session) {
    return {
      status: 422,
      body: {
        ok: false,
        message: 'companyId inválido',
      },
    };
  }

  if (!session.socket) {
    await initCompanySocket(companyId);
  }

  if ((!session.ready || !session.socket) && session.connecting) {
    await waitForSessionReady(session);
  }

  if (!session.ready || !session.socket) {
    return {
      status: 503,
      body: {
        ok: false,
        message: 'Sessão da empresa ainda não está pronta',
        startupError: session.startupError,
      },
    };
  }

  const normalizedNumber = normalizePhone(number);
  const chatId = toWhatsAppJid(normalizedNumber);
  if (!chatId) {
    return {
      status: 422,
      body: {
        ok: false,
        message: 'Número inválido',
      },
    };
  }

  let targetJid = chatId;

  try {
    if (typeof session.socket.onWhatsApp === 'function') {
      const phoneCheck = await session.socket.onWhatsApp(chatId);
      const firstMatch = Array.isArray(phoneCheck) ? phoneCheck[0] : null;

      if (!firstMatch?.exists) {
        return {
          status: 422,
          body: {
            ok: false,
            message: 'Número não encontrado no WhatsApp',
          },
        };
      }

      targetJid = firstMatch.jid || chatId;
    }

    const result = await session.socket.sendMessage(targetJid, { text });

    return {
      status: 200,
      body: {
        ok: true,
        id: result?.key?.id || result?.id?._serialized || null,
        to: normalizedNumber,
        companyId,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      status: 502,
      body: {
        ok: false,
        message: 'Falha ao enviar mensagem para o WhatsApp',
        error: errorMessage,
      },
    };
  }
}

app.get('/health', (_req, res) => {
  return res.json({
    ok: true,
    sessions: companySessions.size,
    connectedSessions: Array.from(companySessions.values()).filter((session) => session.ready).length,
  });
});

app.post('/companies/:companyId/connect', checkAuth, async (req, res) => {
  const companyId = resolveCompanyId(req);
  if (!validateCompanyId(companyId, res)) {
    return;
  }

  const existingSession = getOrCreateSession(companyId);
  if (existingSession?.startupError === 'session_logged_out') {
    if (existingSession.authPath) {
      try {
        fs.rmSync(existingSession.authPath, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[WhatsApp][company:${companyId}] Falha ao limpar sessão no connect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    existingSession.startupError = null;
    existingSession.socket = null;
    existingSession.ready = false;
    existingSession.connecting = false;
    existingSession.lastQr = null;
  }

  const session = await initCompanySocket(companyId);
  return res.status(200).json({
    ok: true,
    companyId,
    ready: Boolean(session?.ready),
    connecting: Boolean(session?.connecting),
    hasQr: Boolean(session?.lastQr),
    startupError: session?.startupError ?? null,
  });
});

app.get('/companies/:companyId/status', checkAuth, (req, res) => {
  const companyId = resolveCompanyId(req);
  if (!validateCompanyId(companyId, res)) {
    return;
  }

  const session = getOrCreateSession(companyId);
  return res.status(200).json({
    ok: true,
    companyId,
    ready: Boolean(session?.ready),
    connecting: Boolean(session?.connecting),
    hasQr: Boolean(session?.lastQr),
    startupError: session?.startupError ?? null,
  });
});

app.get('/companies/:companyId/qr', checkAuth, (req, res) => {
  const companyId = resolveCompanyId(req);
  if (!validateCompanyId(companyId, res)) {
    return;
  }

  const session = getOrCreateSession(companyId);
  return res.status(200).json({
    ok: true,
    companyId,
    qr: session?.lastQr ?? null,
  });
});

app.post('/companies/:companyId/send-text', checkAuth, async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!validateCompanyId(companyId, res)) {
      return;
    }

    const number = String(req.body?.number || '').trim();
    const text = String(req.body?.text || '').trim();
    if (!number || !text) {
      return res.status(422).json({
        ok: false,
        message: 'Campos obrigatórios: number e text',
      });
    }

    const result = await sendTextByCompany(companyId, number, text);
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Falha ao enviar mensagem',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/companies/:companyId/schedule-confirmation', checkAuth, async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!validateCompanyId(companyId, res)) {
      return;
    }

    const appointmentId = String(req.body?.appointmentId || req.body?.appointment_id || '').trim();
    const number = normalizePhone(req.body?.number || req.body?.phone || '');
    const startAt = toIsoDate(resolveStartAtInput(req.body || {}));
    const clientName = String(req.body?.clientName || req.body?.client_name || '').trim();

    if (!appointmentId || !number || !startAt) {
      return res.status(422).json({
        ok: false,
        message: 'Campos obrigatórios: appointmentId, number e startAt (ou date + time)',
      });
    }

    const key = buildConfirmationKey(companyId, appointmentId);
    const maintenanceAtDate = new Date(startAt);
    maintenanceAtDate.setDate(maintenanceAtDate.getDate() + maintenanceDaysAfter);

    const entry = {
      key,
      companyId,
      appointmentId,
      number,
      clientName,
      startAt,
      status: 'scheduled',
      reminderSentAt: null,
      response: null,
      responseAt: null,
      cancelUrl: String(req.body?.cancelUrl || req.body?.cancel_url || '').trim(),
      cancelMethod: String(req.body?.cancelMethod || req.body?.cancel_method || '').trim().toUpperCase(),
      cancelHeaders: req.body?.cancelHeaders && typeof req.body.cancelHeaders === 'object' ? req.body.cancelHeaders : {},
      cancelBody: req.body?.cancelBody ?? null,
      cancelResult: null,
      maintenanceAt: maintenanceAtDate.toISOString(),
      maintenanceStatus: 'pending',
      maintenanceSentAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    upsertConfirmation(entry);

    return res.status(200).json({
      ok: true,
      message: 'Confirmação agendada com sucesso',
      data: {
        key,
        companyId,
        appointmentId,
        number,
        startAt,
        status: entry.status,
        maintenanceAt: entry.maintenanceAt,
        maintenanceStatus: entry.maintenanceStatus,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Falha ao agendar confirmação',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/companies/:companyId/confirmations', checkAuth, (req, res) => {
  const companyId = resolveCompanyId(req);
  if (!validateCompanyId(companyId, res)) {
    return;
  }

  const data = Array.from(confirmationEntries.values())
    .filter((entry) => entry.companyId === companyId)
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  return res.status(200).json({
    ok: true,
    companyId,
    count: data.length,
    data,
  });
});

app.delete('/companies/:companyId/confirmations/:appointmentId', checkAuth, (req, res) => {
  const companyId = resolveCompanyId(req);
  if (!validateCompanyId(companyId, res)) {
    return;
  }

  const appointmentId = String(req.params?.appointmentId || '').trim();
  if (!appointmentId) {
    return res.status(422).json({
      ok: false,
      message: 'Campo obrigatório: appointmentId',
    });
  }

  const key = buildConfirmationKey(companyId, appointmentId);
  const removed = confirmationEntries.delete(key);
  if (removed) {
    persistConfirmations();
  }

  return res.status(200).json({
    ok: true,
    removed,
  });
});

app.post('/send-text', checkAuth, async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    if (!validateCompanyId(companyId, res)) {
      return;
    }

    const number = String(req.body?.number || '').trim();
    const text = String(req.body?.text || '').trim();

    if (!number || !text) {
      return res.status(422).json({
        ok: false,
        message: 'Campos obrigatórios: number e text',
      });
    }

    const result = await sendTextByCompany(companyId, number, text);
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Falha ao enviar mensagem',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(port, () => {
  console.log(`[HTTP] WhatsApp microservice ouvindo na porta ${port}`);
});

console.log('[WhatsApp] Modo multiempresa ativo. Inicialize sessões por companyId.');
