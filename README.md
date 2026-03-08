# Send WhatsApp (não oficial)

Microserviço Node.js para envio de mensagens via WhatsApp Web usando `Baileys`.

## Aviso

Esta integração é **não oficial**. Pode violar termos do WhatsApp e sofrer bloqueios de conta.

## Requisitos

- Node.js 18+
- Conta WhatsApp para escanear QR

## Instalação

```bash
npm install
copy .env.example .env
```

## Executar

```bash
npm start
```

No primeiro start, escaneie o QR no terminal.

## Endpoints

- `GET /health`
- `POST /companies/:companyId/connect`
- `GET /companies/:companyId/status`
- `GET /companies/:companyId/qr`
- `POST /companies/:companyId/send-text`
- `POST /companies/:companyId/schedule-confirmation`
- `GET /companies/:companyId/confirmations`
- `DELETE /companies/:companyId/confirmations/:appointmentId`
- `POST /send-text` (compatível, exige `companyId` no body)

Payload:

```json
{
  "companyId": "1",
  "number": "5511999999999",
  "text": "Olá!"
}
```

Fluxo por empresa:

1. Chame `POST /companies/:companyId/connect` para iniciar sessão e gerar QR.
2. Dono da empresa escaneia o QR do `companyId` dele.
3. Use `POST /companies/:companyId/send-text` para enviar com o WhatsApp dessa empresa.

Se `AUTH_TOKEN` estiver configurado, enviar header:

```http
Authorization: Bearer <AUTH_TOKEN>
```

## Confirmação automática (30 minutos antes)

O endpoint `POST /companies/:companyId/schedule-confirmation` agenda o lembrete de presença do cliente.

Quando faltar o número de minutos definido em `CONFIRMATION_REMINDER_MINUTES` (padrão: `30`), o microserviço envia:

- `1 - Vou comparecer`
- `2 - Não vou comparecer (cancelar agendamento)`

Se o cliente responder `2`, o microserviço tenta cancelar automaticamente via HTTP usando:

- `cancelUrl` do agendamento (se informado), ou
- `CONFIRMATION_CANCEL_URL_TEMPLATE` (ex.: `http://127.0.0.1:8080/appointment/{id}`)

### Exemplo de agendamento de confirmação

```json
{
  "appointmentId": "123",
  "number": "5511999999999",
  "clientName": "Maria",
  "startAt": "2026-02-26T15:00:00-03:00",
  "cancelUrl": "http://127.0.0.1:8080/appointment/123"
}
```

Campos obrigatórios: `appointmentId`, `number` e `startAt`.

Alternativa de payload: em vez de `startAt`, você pode enviar `date` (`YYYY-MM-DD`) e `time` (`HH:mm` ou `HH:mm:ss`).

## Integrar com backend-agenda-pro

No `.env` do backend:

```dotenv
WHATSAPP_ENABLED=true
WHATSAPP_PROVIDER=unofficial_api
WHATSAPP_UNOFFICIAL_ENDPOINT=http://127.0.0.1:3001/send-text
WHATSAPP_UNOFFICIAL_TOKEN=troque-este-token
WHATSAPP_UNOFFICIAL_TOKEN_HEADER=Authorization
WHATSAPP_UNOFFICIAL_TOKEN_PREFIX=Bearer
WHATSAPP_UNOFFICIAL_PHONE_FIELD=number
WHATSAPP_UNOFFICIAL_MESSAGE_FIELD=text
WHATSAPP_UNOFFICIAL_EXTRA_PAYLOAD_JSON=
WHATSAPP_DEFAULT_COUNTRY_CODE=55
```
