import PrebillApiClient from '../core/PrebillApiClient.js';

// Prebills en ReportesSandbox. FASE 1 (decisión del usuario, 2026-11-13): todo hasta "autorizada",
// SIN escribir en Books. Por eso:
//   - No se puede pasar a "facturada" (crea la Invoice en Books) ni deshacer una factura (la borra).
//   - Una Prebill ya facturada no se edita desde aquí: con la factura en borrador, cambiar líneas o
//     idioma también modifica la factura en Books. Se revisa el estado antes de cada edición.
export class PrebillError extends Error {
    constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export const MONEDAS = ['MXN', 'USD', 'EUR'];
export const EDITABLES = ['borrador', 'en_revision', 'autorizada'];
export const AVANCES = ['en_revision', 'autorizada']; // "facturada" queda para la fase 2
const LINEAS = ['agregar_tiempo_id', 'quitar_tiempo_id', 'agregar_gasto_id', 'quitar_gasto_id', 'agregar_cargo_fijo_id', 'quitar_cargo_fijo_id'];
const TIPOS_DESCUENTO = ['monto', 'porcentaje', ''];
const MAX_IDS = 500;

const orgId = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const idParam = value => typeof value === 'string' && /^\d{1,12}$/.test(value);
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);
const isObject = body => body && typeof body === 'object' && !Array.isArray(body);
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9 && Math.round(value * 100) === value * 100;

function idList(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_IDS || !value.every(v => Number.isInteger(v) && v > 0)) {
        throw new PrebillError(`${name} debe ser una lista de IDs (enteros, máximo ${MAX_IDS}).`);
    }
    return [...new Set(value)];
}

export function validateCreate(body) {
    if (!isObject(body)) throw new PrebillError('Se requiere un objeto JSON.');
    if (typeof body.cliente_id !== 'string' || !/^\d{1,25}$/.test(body.cliente_id)) throw new PrebillError('cliente_id debe ser el ID del cliente en Books.');
    if (!MONEDAS.includes(body.moneda)) throw new PrebillError('moneda debe ser MXN, USD o EUR.');
    const payload = { cliente_id: body.cliente_id, moneda: body.moneda };
    for (const key of ['tiempo_id', 'gasto_id', 'cargo_fijo_id']) {
        const ids = idList(body[key], key);
        if (ids.length) payload[key] = ids;
    }
    if (!payload.tiempo_id && !payload.gasto_id && !payload.cargo_fijo_id) throw new PrebillError('Elige al menos un tiempo, gasto u honorario fijo.');
    return payload;
}

export function validateLineas(body) {
    if (!isObject(body)) throw new PrebillError('Se requiere un objeto JSON.');
    const payload = {};
    for (const key of LINEAS) {
        const ids = idList(body[key], key);
        if (ids.length) payload[key] = ids;
    }
    if (!Object.keys(payload).length) throw new PrebillError('No hay líneas que agregar ni quitar.');
    return payload;
}

// Descuento y ajuste: solo sobre honorarios (regla de la API). Tipo vacío = quitarlo.
export function validateDescuentoAjuste(body) {
    if (!isObject(body)) throw new PrebillError('Se requiere un objeto JSON.');
    const payload = {};
    for (const kind of ['descuento', 'ajuste']) {
        if (!has(body, kind + '_tipo')) continue;
        const tipo = body[kind + '_tipo'];
        if (!TIPOS_DESCUENTO.includes(tipo)) throw new PrebillError(`${kind}_tipo debe ser monto, porcentaje o vacío.`);
        payload[kind + '_tipo'] = tipo;
        if (tipo === '') { payload[kind + '_valor'] = ''; continue; }
        const valor = body[kind + '_valor'];
        if (!money(valor) || valor === 0) throw new PrebillError(`${kind}_valor debe ser mayor que cero, con máximo 2 decimales.`);
        if (tipo === 'porcentaje' && valor > 100) throw new PrebillError(`El ${kind} en porcentaje no puede pasar de 100.`);
        payload[kind + '_valor'] = valor;
    }
    if (!Object.keys(payload).length) throw new PrebillError('Indica el descuento o el ajuste.');
    return payload;
}

export function validateIdioma(body) {
    if (!isObject(body) || !['es', 'en', ''].includes(body.idioma)) throw new PrebillError('idioma debe ser es, en o vacío (el del cliente).');
    return { idioma: body.idioma };
}

export function validateTipoCambio(body) {
    if (!isObject(body) || !has(body, 'tipo_cambio')) throw new PrebillError('Indica tipo_cambio (o null para usar el FIX de Banxico).');
    const value = body.tipo_cambio;
    if (value === null) return { tipo_cambio: '' };
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10000 || Math.round(value * 1e6) !== value * 1e6) {
        throw new PrebillError('tipo_cambio debe ser un número mayor que cero, con máximo 6 decimales.');
    }
    return { tipo_cambio: value };
}

export function validateEstado(body) {
    if (!isObject(body)) throw new PrebillError('Se requiere un objeto JSON.');
    if (body.nuevo_estado === 'facturada') throw new PrebillError('Facturar crea la factura en Books y todavía no está habilitado aquí. Hazlo desde Aptus.', 403);
    if (!AVANCES.includes(body.nuevo_estado)) throw new PrebillError('nuevo_estado debe ser en_revision o autorizada.');
    return { nuevo_estado: body.nuevo_estado };
}

const unexpected = what => new PrebillError(`El servicio de Aptus devolvió ${what} con formato inesperado.`, 502, { stage: 'response', outcome_unknown: true });
const statusOf = prebill => prebill.status ?? prebill.estado;

export default class PrebillService {
    constructor(organizationId, { api = null, req = null } = {}) {
        if (!orgId(organizationId)) throw new PrebillError('Organización inválida.');
        this.api = api ?? new PrebillApiClient(organizationId, { req });
    }

    check(id) { if (!idParam(id)) throw new PrebillError('ID de Prebill inválido.'); }

    async get(id) {
        this.check(id);
        const data = await this.api.request('get', '/prebills/' + id, { stage: 'get_prebill' });
        if (!data || !Number.isInteger(data.id)) throw unexpected('una Prebill');
        return data;
    }

    // Lecturas por Prebill (vista-factura y edicion consultan Books, sin escribir).
    async read(id, what) {
        this.check(id);
        return this.api.request('get', `/prebills/${id}/${what}`, { stage: what.replace('-', '_') });
    }

    // Antes de editar: la Prebill no debe estar facturada (ni facturándose).
    async editable(id, allowed = EDITABLES) {
        const prebill = await this.get(id);
        const status = statusOf(prebill);
        if (!allowed.includes(status)) {
            throw new PrebillError(status === 'facturada' || status === 'facturando'
                ? 'Esta Prebill ya está facturada: cambiarla también cambiaría la factura en Books. Hazlo desde Aptus.'
                : `En estado "${status}" no se puede hacer este cambio.`, 409, { stage: 'estado_prebill' });
        }
        return prebill;
    }

    async create(body) {
        const payload = validateCreate(body);
        const data = await this.api.request('post', '/prebills', { data: payload, stage: 'create_prebill' });
        if (!data || !Number.isInteger(data.id)) throw unexpected('la Prebill creada');
        return data;
    }

    async lineas(id, body) {
        this.check(id);
        const payload = validateLineas(body);
        await this.editable(id);
        return this.api.request('patch', `/prebills/${id}/lineas`, { data: payload, stage: 'lineas_prebill' });
    }

    async descuentoAjuste(id, body) {
        this.check(id);
        const payload = validateDescuentoAjuste(body);
        await this.editable(id, ['borrador']);
        return this.api.request('patch', `/prebills/${id}/descuento-ajuste`, { data: payload, stage: 'descuento_prebill' });
    }

    async idioma(id, body) {
        this.check(id);
        const payload = validateIdioma(body);
        await this.editable(id);
        return this.api.request('patch', `/prebills/${id}/idioma`, { data: payload, stage: 'idioma_prebill' });
    }

    async tipoCambio(id, body) {
        this.check(id);
        const payload = validateTipoCambio(body);
        await this.editable(id);
        return this.api.request('patch', `/prebills/${id}/tipo-cambio`, { data: payload, stage: 'tipo_cambio_prebill' });
    }

    async estado(id, body) {
        this.check(id);
        const payload = validateEstado(body);
        await this.editable(id);
        return this.api.request('post', `/prebills/${id}/estado`, { data: payload, stage: 'estado_prebill' });
    }

    async remove(id) {
        this.check(id);
        await this.editable(id, ['borrador']);
        return this.api.request('delete', '/prebills/' + id, { stage: 'delete_prebill' });
    }
}
