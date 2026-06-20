# Variables de entorno de producción

Esta versión no incluye `functions/.env` para no exponer tokens de Meta/WhatsApp dentro del ZIP.

Antes de desplegar Functions, conservá tus variables reales en tu entorno de Firebase o en un `.env` local NO compartido:

- WHATSAPP_VERIFY_TOKEN
- DEFAULT_RESPONSABLE
- WHATSAPP_API_VERSION
- WHATSAPP_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- ALHER_SALES_BOT_ENABLED
- ALHER_API_SHARED_SECRET (opcional, recomendado para proteger endpoints POST del CRM)

Importante: no se borra ni se modifica ninguna colección de Firestore por esta limpieza.
