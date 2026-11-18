import axios from 'axios';
import DbConfigService from '../core/DbConfigService.js';
import { PrebillError } from './PrebillService.js';

// Formato imprimible de una Prebill (GET /formatos/prebill/:id de ReportesSandbox): PDF o HTML.
// Solo lectura: no adjunta nada en Books ni en Creator. Es binario, así que no pasa por
// core/PrebillApiClient (que solo acepta JSON); usa la misma conexión (cm_global_vars, en caché).
// Nunca se registra la URL ni el error de axios: llevan el token.
export const FORMATOS = ['carta', 'detallado'];
export const IDIOMAS = ['es', 'en'];
export const SALIDAS = ['pdf', 'html'];
// Catalyst corta a los 30 s; el primer PDF tras reiniciar ReportesSandbox tarda ~30 s.
export const FORMATO_TIMEOUT = 25000;
const MAX_BYTES = 15 * 1024 * 1024;

const orgId = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const idParam = value => typeof value === 'string' && /^\d{1,12}$/.test(value);

export function validateFormato(query = {}) {
    const params = {};
    const pick = (name, allowed, label) => {
        const v = query[name];
        if (v === undefined || v === '') return;
        if (typeof v !== 'string' || !allowed.includes(v)) throw new PrebillError(`${label} inválido.`);
        params[name] = v;
    };
    pick('formato', FORMATOS, 'Formato');
    pick('idioma', IDIOMAS, 'Idioma');
    pick('salida', SALIDAS, 'Tipo de archivo');
    params.salida ??= 'pdf';
    if (query.descargar === '1') params.descargar = '1';
    return params;
}

// Quita el token (también codificado para URL) de un texto.
// Primero quita los enlaces de la barra de ReportesSandbox (llevan el token y apuntan a su sitio;
// desde Books no sirven). Queda el botón "Imprimir" de la barra.
export function quitarToken(text, token) {
    let out = text.replace(/<a\b[^>]*\btoken=[^>]*>[\s\S]*?<\/a>/gi, '');
    if (!token) return out;
    for (const t of new Set([String(token), encodeURIComponent(String(token))])) out = out.split(t).join('');
    return out;
}

// Nombre del archivo: Prebill-<id>-<formato>.<ext> (sin caracteres raros).
export const nombreArchivo = (id, params) => `Prebill-${id}${params.formato ? '-' + params.formato : ''}.${params.salida === 'html' ? 'html' : 'pdf'}`;

function errorDe(cause) {
    if (cause?.code === 'ECONNABORTED' || /timeout/i.test(cause?.message ?? '')) {
        return Object.assign(new PrebillError('El PDF tardó demasiado en generarse. El primero después de reiniciar el servicio tarda unos 30 s: vuelve a intentarlo o abre la versión para imprimir.', 504), { stage: 'formato', outcome_unknown: false });
    }
    const status = cause?.response?.status;
    let apiMessage = null;
    try {
        const raw = cause?.response?.data;
        const text = raw ? Buffer.from(raw).toString('utf8') : '';
        const json = JSON.parse(text);
        if (typeof json?.error === 'string') apiMessage = json.error;
    } catch { /* no era JSON */ }
    if ([400, 404, 409].includes(status) && apiMessage) return Object.assign(new PrebillError(apiMessage, status), { stage: 'formato', outcome_unknown: false });
    if (status === 503) return Object.assign(new PrebillError('El PDF no está disponible en este momento. Abre la versión para imprimir y usa "Imprimir" del navegador.', 503), { stage: 'formato', outcome_unknown: false });
    return Object.assign(new PrebillError('No se pudo generar el formato en el servicio de Aptus.', 502), { stage: 'formato', outcome_unknown: false, provider_status: status ?? null });
}

export default class FormatoService {
    constructor(organizationId, { http = axios, config = null, req = null } = {}) {
        if (!orgId(organizationId)) throw new PrebillError('Organización inválida.');
        this.http = http;
        this.config = config ?? { get: async () => {
            const c = await new DbConfigService(organizationId, req).getDbConfig();
            return { endpoint: c.APTUS_MIRROR_DB_ENDPOINT, token: c.APTUS_MIRROR_DB_TOKEN };
        } };
    }

    // Devuelve { contentType, filename, body (Buffer), disposition }.
    async prebill(id, query) {
        if (!idParam(id)) throw new PrebillError('ID de Prebill inválido.');
        const params = validateFormato(query);
        let connection;
        try { connection = await this.config.get(); } catch { connection = null; }
        if (!connection?.endpoint || !connection?.token) {
            throw Object.assign(new PrebillError('Faltan parámetros de conexión con el servicio de Aptus. Por favor contacte a un administrador.', 503), { stage: 'connection', outcome_unknown: false });
        }
        const url = String(connection.endpoint).replace(/\/+$/, '') + `/formatos/prebill/${id}`;
        let response;
        try {
            response = await this.http.request({
                method: 'get', url, params: { ...params, token: connection.token }, timeout: FORMATO_TIMEOUT,
                responseType: 'arraybuffer', maxContentLength: MAX_BYTES,
            });
        } catch (cause) {
            throw errorDe(cause);
        }
        const contentType = String(response.headers?.['content-type'] ?? '');
        const esperado = params.salida === 'html' ? /text\/html/ : /application\/pdf/;
        if (!esperado.test(contentType)) throw Object.assign(new PrebillError('El servicio de Aptus devolvió un formato inesperado.', 502), { stage: 'formato', outcome_unknown: false });
        const filename = nombreArchivo(id, params);
        let body = Buffer.from(response.data);
        // La versión HTML puede traer enlaces a la API con el token: nunca se manda al navegador.
        if (params.salida === 'html') body = Buffer.from(quitarToken(body.toString('utf8'), connection.token), 'utf8');
        return {
            contentType: params.salida === 'html' ? 'text/html; charset=utf-8' : 'application/pdf',
            filename,
            disposition: `${params.descargar ? 'attachment' : 'inline'}; filename="${filename}"`,
            body,
        };
    }
}
