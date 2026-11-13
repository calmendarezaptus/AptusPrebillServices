import test from 'node:test';
import assert from 'node:assert/strict';
import PrebillService, { validateCreate, validateLineas, validateDescuentoAjuste, validateEstado, validateTipoCambio, validateIdioma } from '../services/PrebillService.js';

function fixture(responses = {}) {
    const calls = [];
    const api = {
        async request(method, path, opts) {
            calls.push({ method, path, opts });
            const key = `${method} ${path}`;
            if (key in responses) return typeof responses[key] === 'function' ? responses[key]() : responses[key];
            return { id: 7 };
        },
    };
    return { service: new PrebillService('636939444', { api }), calls };
}
const writes = calls => calls.filter(c => c.method !== 'get');
const prebill = status => ({ 'get /prebills/7': { id: 7, status } });

test('crear: cliente, moneda y al menos una línea; IDs enteros sin repetir', () => {
    assert.deepEqual(validateCreate({ cliente_id: '446794000018976759', moneda: 'MXN', tiempo_id: [80, 80, 81], gasto_id: [], extra: 1, cliente_nombre: 'X' }),
        { cliente_id: '446794000018976759', moneda: 'MXN', tiempo_id: [80, 81] });
    for (const body of [{ moneda: 'MXN', tiempo_id: [1] }, { cliente_id: '1', moneda: 'COP', tiempo_id: [1] }, { cliente_id: '1', moneda: 'MXN' },
        { cliente_id: '1', moneda: 'MXN', tiempo_id: ['1'] }, { cliente_id: '1', moneda: 'MXN', gasto_id: [0] }, { cliente_id: '1', moneda: 'MXN', gasto_id: 3 },
        { cliente_id: '1', moneda: 'MXN', tiempo_id: Array.from({ length: 501 }, (_, i) => i + 1) }, null]) {
        assert.throws(() => validateCreate(body), undefined, JSON.stringify(body)?.slice(0, 80));
    }
});

test('líneas, descuento, idioma y tipo de cambio validan antes de llamar', () => {
    assert.deepEqual(validateLineas({ agregar_tiempo_id: [72], quitar_gasto_id: [24, 24], otra: [1] }), { agregar_tiempo_id: [72], quitar_gasto_id: [24] });
    assert.throws(() => validateLineas({}));
    assert.deepEqual(validateDescuentoAjuste({ descuento_tipo: 'porcentaje', descuento_valor: 10 }), { descuento_tipo: 'porcentaje', descuento_valor: 10 });
    assert.deepEqual(validateDescuentoAjuste({ descuento_tipo: '', ajuste_tipo: 'monto', ajuste_valor: 500.5 }), { descuento_tipo: '', descuento_valor: '', ajuste_tipo: 'monto', ajuste_valor: 500.5 });
    for (const body of [{}, { descuento_tipo: 'porcentaje', descuento_valor: 101 }, { descuento_tipo: 'monto', descuento_valor: -1 }, { descuento_tipo: 'monto', descuento_valor: 0 },
        { descuento_tipo: 'monto', descuento_valor: 1.234 }, { ajuste_tipo: 'otro', ajuste_valor: 1 }]) {
        assert.throws(() => validateDescuentoAjuste(body), undefined, JSON.stringify(body));
    }
    assert.deepEqual(validateIdioma({ idioma: '' }), { idioma: '' });
    assert.throws(() => validateIdioma({ idioma: 'fr' }));
    assert.deepEqual(validateTipoCambio({ tipo_cambio: 18.1234 }), { tipo_cambio: 18.1234 });
    assert.deepEqual(validateTipoCambio({ tipo_cambio: null }), { tipo_cambio: '' });
    for (const v of [0, -1, '18', 1.1234567]) assert.throws(() => validateTipoCambio({ tipo_cambio: v }), undefined, String(v));
});

test('FASE 1: facturar no está permitido y no hay ruta para deshacer factura', () => {
    assert.throws(() => validateEstado({ nuevo_estado: 'facturada' }), e => e.status === 403);
    assert.throws(() => validateEstado({ nuevo_estado: 'borrador' }), e => e.status === 400);
    assert.deepEqual(validateEstado({ nuevo_estado: 'autorizada' }), { nuevo_estado: 'autorizada' });
    assert.equal(PrebillService.prototype.deshacerFactura, undefined);
});

test('una Prebill facturada no se edita (cambiaría la factura en Books)', async () => {
    for (const status of ['facturada', 'facturando']) {
        const f = fixture(prebill(status));
        await assert.rejects(f.service.lineas('7', { agregar_tiempo_id: [72] }), e => e.status === 409 && /Books/.test(e.message));
        await assert.rejects(f.service.idioma('7', { idioma: 'en' }), e => e.status === 409);
        await assert.rejects(f.service.tipoCambio('7', { tipo_cambio: 18 }), e => e.status === 409);
        await assert.rejects(f.service.estado('7', { nuevo_estado: 'autorizada' }), e => e.status === 409);
        await assert.rejects(f.service.remove('7'), e => e.status === 409);
        await assert.rejects(f.service.descuentoAjuste('7', { descuento_tipo: '' }), e => e.status === 409);
        assert.equal(writes(f.calls).length, 0, status);
    }
});

test('en estados editables se reenvía el cuerpo validado', async () => {
    let f = fixture(prebill('autorizada'));
    await f.service.lineas('7', { agregar_tiempo_id: [72] });
    await f.service.idioma('7', { idioma: 'en' });
    await f.service.tipoCambio('7', { tipo_cambio: 18.5 });
    await f.service.estado('7', { nuevo_estado: 'autorizada' });
    assert.deepEqual(writes(f.calls).map(c => [c.method, c.path, c.opts.data]), [
        ['patch', '/prebills/7/lineas', { agregar_tiempo_id: [72] }],
        ['patch', '/prebills/7/idioma', { idioma: 'en' }],
        ['patch', '/prebills/7/tipo-cambio', { tipo_cambio: 18.5 }],
        ['post', '/prebills/7/estado', { nuevo_estado: 'autorizada' }],
    ]);
    // Descuento y borrar: solo en borrador
    await assert.rejects(f.service.descuentoAjuste('7', { descuento_tipo: '' }), e => e.status === 409);
    await assert.rejects(f.service.remove('7'), e => e.status === 409);
    f = fixture(prebill('borrador'));
    await f.service.descuentoAjuste('7', { descuento_tipo: 'monto', descuento_valor: 1000 });
    await f.service.remove('7');
    assert.deepEqual(writes(f.calls).map(c => `${c.method} ${c.path}`), ['patch /prebills/7/descuento-ajuste', 'delete /prebills/7']);
});

test('crear devuelve la Prebill con ids_ignorados; IDs de ruta inválidos no llaman', async () => {
    const f = fixture({ 'post /prebills': { id: 9, ids_ignorados: { tiempo_id: [5] } } });
    const r = await f.service.create({ cliente_id: '1', moneda: 'MXN', tiempo_id: [5, 6] });
    assert.deepEqual(r.ids_ignorados, { tiempo_id: [5] });
    await assert.rejects(fixture({ 'post /prebills': { ok: true } }).service.create({ cliente_id: '1', moneda: 'MXN', tiempo_id: [5] }), e => e.outcome_unknown === true);
    const g = fixture();
    await assert.rejects(g.service.get('7/../x'), e => e.status === 400);
    await assert.rejects(g.service.read('abc', 'disponible'), e => e.status === 400);
    assert.equal(g.calls.length, 0);
    assert.throws(() => new PrebillService('abc', { api: {} }), e => e.status === 400);
});
