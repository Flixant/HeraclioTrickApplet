# Deploy Voice: Railway + Vercel

## 1) Backend en Railway

1. Crea servicio desde carpeta `server`.
2. Variables en Railway:
   - `PORT=3001` (opcional, Railway lo inyecta)
   - `FRONTEND_ORIGIN=https://TU_APP.vercel.app`
   - `CORS_ALLOW_ALL=0`
3. Deploy y copia URL pública del backend:
   - Ejemplo: `https://truco-backend-production.up.railway.app`
4. Test:
   - `GET https://.../health` debe devolver `{ ok: true }`.

## 2) Frontend en Vercel

1. Importa repo, root en `client`.
2. Variables en Vercel:
   - `VITE_SERVER_URL=https://TU_BACKEND.up.railway.app`
   - `VITE_SOCKET_TRANSPORTS=polling,websocket`
   - `VITE_SOCKET_UPGRADE=1`
   - `VITE_VOICE_DEBUG=true` (opcional)
   - `VITE_WEBRTC_STUN_URLS=stun:stun.l.google.com:19302`
   - `VITE_WEBRTC_TURN_URLS=...` (opcional pero recomendado para producción)
   - `VITE_WEBRTC_TURN_USERNAME=...`
   - `VITE_WEBRTC_TURN_CREDENTIAL=...`
3. Redeploy.

## 3) Prueba end-to-end

1. Abre la app Vercel en dos dispositivos.
2. Entren a la misma mesa.
3. Activen micrófono en ambos.
4. Debes escuchar audio y ver animación de avatar cuando alguien habla.

## 4) Si no hay audio

1. Sin TURN, algunas redes no enrutan audio P2P.
2. Agrega TURN y vuelve a desplegar.
3. Mantén `VITE_SOCKET_TRANSPORTS=polling,websocket` para máxima compatibilidad móvil.
