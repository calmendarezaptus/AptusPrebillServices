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

test('facturar: solo desde autorizada; espera a Books hasta 27 s', async () => {
    assert.deepEqual(validateEstado({ nuevo_estado: 'facturada' }), { nuevo_estado: 'facturada' });
    assert.throws(() => validateEstado({ nuevo_estado: 'borrador' }), e => e.status === 400);
    let f = fixture({ ...prebill('en_revision') });
    await assert.rejects(f.service.estado('7', { nuevo_estado: 'facturada' }), e => e.status === 409);
    assert.equal(writes(f.calls).length, 0);
    f = fixture({ ...prebill('autorizada'), 'get /prebills/7/vista-factura': { bloqueantes: [] }, 'post /prebills/7/estado': { id: 7, status: 'facturada', invoice_number: 'INV-1' } });
    const r = await f.service.estado('7', { nuevo_estado: 'facturada' });
    assert.equal(r.invoice_number, 'INV-1');
    const w = writes(f.calls);
    assert.deepEqual(w.map(c => [c.path, c.opts.data, c.opts.timeout]), [['/prebills/7/estado', { nuevo_estado: 'facturada' }, 27000]]);
    // Respuesta sin id = incierta (puede haberse creado la factura)
    f = fixture({ ...prebill('autorizada'), 'get /prebills/7/vista-factura': { bloqueantes: [] }, 'post /prebills/7/estado': {} });
    await assert.rejects(f.service.estado('7', { nuevo_estado: 'facturada' }), e => e.outcome_unknown === true);
});

test('deshacer factura: solo facturada con la factura en borrador', async () => {
    let f = fixture(prebill('autorizada'));
    await assert.rejects(f.service.deshacerFactura('7'), e => e.status === 409);
    f = fixture({ ...prebill('facturada'), 'get /prebills/7/edicion': { editable: false, etapa: 'bloqueada', motivo: 'La factura INV-000863 ya no se puede modificar' } });
    await assert.rejects(f.service.deshacerFactura('7'), e => e.status === 409 && /INV-000863/.test(e.message));
    assert.equal(writes(f.calls).length, 0);
    f = fixture({ ...prebill('facturada'), 'get /prebills/7/edicion': { editable: true, etapa: 'factura_borrador' }, 'post /prebills/7/deshacer-factura': { id: 7, status: 'autorizada', factura_borrada: 'INV-1' } });
    await f.service.deshacerFactura('7');
    assert.deepEqual(writes(f.calls).map(c => [c.path, c.opts.timeout]), [['/prebills/7/deshacer-factura', 27000]]);
});

test('facturada: líneas e idioma solo con la factura en borrador (y actualizan Books)', async () => {
    let f = fixture({ ...prebill('facturada'), 'get /prebills/7/edicion': { editable: false, etapa: 'bloqueada', motivo: 'ya se envió' } });
    await assert.rejects(f.service.lineas('7', { agregar_tiempo_id: [72] }), e => e.status === 409 && /envió/.test(e.message));
    await assert.rejects(f.service.idioma('7', { idioma: 'en' }), e => e.status === 409);
    assert.equal(writes(f.calls).length, 0);
    f = fixture({ ...prebill('facturada'), 'get /prebills/7/edicion': { editable: true, etapa: 'factura_borrador' } });
    await f.service.lineas('7', { quitar_gasto_id: [24] });
    await f.service.idioma('7', { idioma: 'en' });
    assert.deepEqual(writes(f.calls).map(c => [c.path, c.opts.timeout]), [['/prebills/7/lineas', 27000], ['/prebills/7/idioma', 27000]]);
    // Descuento, tipo de cambio, avanzar y borrar siguen sin tocar una facturada
    await assert.rejects(f.service.descuentoAjuste('7', { descuento_tipo: '' }), e => e.status === 409);
    await assert.rejects(f.service.tipoCambio('7', { tipo_cambio: 18 }), e => e.status === 409);
    await assert.rejects(f.service.estado('7', { nuevo_estado: 'autorizada' }), e => e.status === 409);
    await assert.rejects(f.service.remove('7'), e => e.status === 409);
    assert.equal(writes(f.calls).length, 2);
    // Facturándose: nada
    f = fixture(prebill('facturando'));
    await assert.rejects(f.service.lineas('7', { agregar_tiempo_id: [72] }), e => e.status === 409);
    assert.equal(writes(f.calls).length, 0);
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
