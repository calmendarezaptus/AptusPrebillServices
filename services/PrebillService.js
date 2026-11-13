import PrebillApiClient from '../core/PrebillApiClient.js';

// Prebills en ReportesSandbox. FASE 2 (aprobada por el usuario, 2026-11-13, opción "todo"):
//   - Facturar (autorizada → facturada) CREA la factura en Books (borrador). Solo desde autorizada;
//     si la vista previa tiene bloqueos, ReportesSandbox responde 409 antes de tocar Books.
//   - Deshacer factura BORRA la factura en Books y regresa la Prebill a autorizada. Solo si la
//     factura sigue en borrador (etapa factura_borrador).
//   - Con la factura en borrador, cambiar líneas o idioma también ACTUALIZA la factura en Books.
//     Se revisa /edicion antes: si ya se envió, tiene pagos o está vencida, no se intenta.
//   - Nunca se crean usuarios ni contactos en Books. ReportesSandbox protege contra doble factura.
export class PrebillError extends Error {
    constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export const MONEDAS = ['MXN', 'USD', 'EUR'];
export const EDITABLES = ['borrador', 'en_revision', 'autorizada'];
export const AVANCES = ['en_revision', 'autorizada', 'facturada'];
// Catalyst corta una función Advanced I/O a los 30 s: se espera a Books hasta 27 s y, si no
// responde, se contesta "resultado por verificar" (ReportesSandbox termina y evita doble factura).
export const BOOKS_TIMEOUT = 27000;
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
    if (!AVANCES.includes(body.nuevo_estado)) throw new PrebillError('nuevo_estado debe ser en_revision, autorizada o facturada.');
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

    // allowed: estados en que se permite. Con conFactura, una facturada también, si su factura
    // sigue en borrador en Books (lo dice /edicion, que consulta Books sin escribir).
    async editable(id, allowed = EDITABLES, { conFactura = false } = {}) {
        const prebill = await this.get(id);
        const status = statusOf(prebill);
        if (allowed.includes(status)) return { prebill, enBooks: false };
        if (status === 'facturando') throw new PrebillError('La Prebill se está facturando en este momento. Espera y actualiza.', 409, { stage: 'estado_prebill' });
        if (conFactura && status === 'facturada') {
            const edicion = await this.api.request('get', `/prebills/${id}/edicion`, { stage: 'edicion' });
            if (edicion?.editable === true && edicion.etapa === 'factura_borrador') return { prebill, enBooks: true, edicion };
            throw new PrebillError(edicion?.motivo || 'La factura ya no se puede modificar.', 409, { stage: 'estado_prebill' });
        }
        throw new PrebillError(`En estado "${status}" no se puede hacer este cambio.`, 409, { stage: 'estado_prebill' });
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
        const { enBooks } = await this.editable(id, EDITABLES, { conFactura: true });
        return this.api.request('patch', `/prebills/${id}/lineas`, { data: payload, stage: 'lineas_prebill', timeout: enBooks ? BOOKS_TIMEOUT : 30000 });
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
        const { enBooks } = await this.editable(id, EDITABLES, { conFactura: true });
        return this.api.request('patch', `/prebills/${id}/idioma`, { data: payload, stage: 'idioma_prebill', timeout: enBooks ? BOOKS_TIMEOUT : 30000 });
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
        if (payload.nuevo_estado !== 'facturada') {
            await this.editable(id);
            return this.api.request('post', `/prebills/${id}/estado`, { data: payload, stage: 'estado_prebill' });
        }
        // Facturar: solo desde autorizada. Los bloqueos los revisa ReportesSandbox (409) antes de Books.
        await this.editable(id, ['autorizada']);
        const data = await this.api.request('post', `/prebills/${id}/estado`, { data: payload, stage: 'facturar_prebill', timeout: BOOKS_TIMEOUT });
        if (!data || !Number.isInteger(data.id)) throw unexpected('la Prebill facturada');
        return data;
    }

    // Borra la factura en Books (solo si sigue en borrador) y regresa la Prebill a autorizada.
    async deshacerFactura(id) {
        this.check(id);
        const prebill = await this.get(id);
        if (statusOf(prebill) !== 'facturada') throw new PrebillError('Solo se deshace la factura de una Prebill facturada.', 409, { stage: 'estado_prebill' });
        const edicion = await this.api.request('get', `/prebills/${id}/edicion`, { stage: 'edicion' });
        if (edicion?.etapa !== 'factura_borrador') throw new PrebillError(edicion?.motivo || 'La factura ya no está en borrador; anúlala en Books.', 409, { stage: 'estado_prebill' });
        const data = await this.api.request('post', `/prebills/${id}/deshacer-factura`, { data: {}, stage: 'deshacer_factura', timeout: BOOKS_TIMEOUT });
        if (!data || !Number.isInteger(data.id)) throw unexpected('la Prebill');
        return data;
    }

    async remove(id) {
        this.check(id);
        await this.editable(id, ['borrador']);
        return this.api.request('delete', '/prebills/' + id, { stage: 'delete_prebill' });
    }
}
