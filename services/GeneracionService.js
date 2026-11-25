import PrebillApiClient from '../core/PrebillApiClient.js';
import { PrebillError } from './PrebillService.js';

// Generación masiva de Prebills (ReportesSandbox: GET /prebills/generar/vista-previa y POST /prebills/generar).
// Cada proyecto dice si va con el cliente (una Prebill por cliente y moneda, dividida por proyecto) o en una
// Prebill propia. La vista previa no crea nada; generar exige `confirmar: true` y un `solicitud_id` (idempotente:
// repetirlo devuelve el mismo resultado). Las Prebills nacen en borrador: no escribe en Books.
const orgId = v => typeof v === 'string' && /^\d{1,20}$/.test(v);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const MONEDAS = ['MXN', 'USD', 'EUR'];
const CLAVE = /^[cp]:[\w-]{1,30}:[A-Z]{3}$/;
const SOLICITUD = /^[\w-]{8,100}$/;
export const GENERAR_TIMEOUT = 25000;

const bad = message => new PrebillError(message, 400, { stage: 'validation', outcome_unknown: false });

export function validateFiltros(src = {}) {
    const out = {};
    const { desde, hasta, cliente_id, moneda } = src;
    const hayDesde = desde !== undefined && desde !== null && desde !== '';
    const hayHasta = hasta !== undefined && hasta !== null && hasta !== '';
    if (hayDesde !== hayHasta) throw bad('Indica las dos fechas del rango (desde y hasta) o ninguna.');
    if (hayDesde) {
        if (!isDate(desde) || !isDate(hasta)) throw bad('Fechas inválidas: usa AAAA-MM-DD.');
        if (desde > hasta) throw bad('La fecha inicial es posterior a la final.');
        out.desde = desde; out.hasta = hasta;
    }
    if (cliente_id !== undefined && cliente_id !== null && cliente_id !== '') {
        if (typeof cliente_id !== 'string' || !/^\d{1,25}$/.test(cliente_id)) throw bad('cliente_id inválido.');
        out.cliente_id = cliente_id;
    }
    if (moneda !== undefined && moneda !== null && moneda !== '') {
        if (!MONEDAS.includes(moneda)) throw bad('moneda debe ser MXN, USD o EUR.');
        out.moneda = moneda;
    }
    return out;
}

export function validateGenerar(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Se requiere un objeto JSON.');
    if (body.confirmar !== true) throw bad('Falta confirmar la generación (confirmar: true).');
    if (typeof body.solicitud_id !== 'string' || !SOLICITUD.test(body.solicitud_id)) throw bad('solicitud_id inválido (8 a 100 letras, números, guion o guion bajo).');
    const out = { confirmar: true, solicitud_id: body.solicitud_id, ...validateFiltros(body) };
    if (body.grupos !== undefined && body.grupos !== null) {
        if (!Array.isArray(body.grupos) || body.grupos.length > 500 || !body.grupos.every(g => typeof g === 'string' && CLAVE.test(g))) throw bad('grupos debe ser una lista de claves de la vista previa.');
        if (new Set(body.grupos).size !== body.grupos.length) throw bad('grupos tiene claves repetidas.');
        out.grupos = body.grupos;
    }
    return out;
}

const unexpected = what => new PrebillError(`El servicio de Aptus devolvió ${what} con formato inesperado.`, 502, { stage: 'response', outcome_unknown: true });

export default class GeneracionService {
    constructor(organizationId, { api = null, req = null } = {}) {
        if (!orgId(organizationId)) throw bad('Organización inválida.');
        this.api = api ?? new PrebillApiClient(organizationId, { req });
    }

    async vistaPrevia(query) {
        const data = await this.api.request('get', '/prebills/generar/vista-previa', { params: validateFiltros(query), stage: 'generar_vista_previa', timeout: GENERAR_TIMEOUT });
        if (!data || !Array.isArray(data.grupos)) throw unexpected('la vista previa');
        return data;
    }

    async generar(body) {
        const payload = validateGenerar(body);
        const data = await this.api.request('post', '/prebills/generar', { data: payload, stage: 'generar_prebills', timeout: GENERAR_TIMEOUT });
        if (!data || !Array.isArray(data.creadas)) throw unexpected('la generación');
        return data;
    }
}
