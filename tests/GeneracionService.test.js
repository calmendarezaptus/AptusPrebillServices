import test from 'node:test';
import assert from 'node:assert/strict';
import GeneracionService, { validateFiltros, validateGenerar } from '../services/GeneracionService.js';

test('filtros: todo o rango completo; cliente y moneda opcionales', () => {
    assert.deepEqual(validateFiltros({}), {});
    assert.deepEqual(validateFiltros({ desde: '2026-10-01', hasta: '2026-10-31', moneda: 'MXN', otro: 'x' }), { desde: '2026-10-01', hasta: '2026-10-31', moneda: 'MXN' });
    assert.throws(() => validateFiltros({ desde: '2026-10-01' }), /dos fechas/);
    assert.throws(() => validateFiltros({ desde: '2026-11-01', hasta: '2026-10-01' }), /posterior/);
    assert.throws(() => validateFiltros({ desde: '2026-02-30', hasta: '2026-03-01' }), /inválidas/);
    assert.throws(() => validateFiltros({ moneda: 'GBP' }), /moneda/);
    assert.throws(() => validateFiltros({ cliente_id: 'abc' }), /cliente_id/);
});

test('generar: confirmar, solicitud_id y claves de la vista previa', () => {
    const ok = { confirmar: true, solicitud_id: 'gen-1234abcd' };
    assert.deepEqual(validateGenerar({ ...ok, grupos: ['c:446794000018976769:MXN', 'p:23:USD'] }), { ...ok, grupos: ['c:446794000018976769:MXN', 'p:23:USD'] });
    assert.deepEqual(validateGenerar({ ...ok, desde: '2026-10-01', hasta: '2026-10-31' }), { ...ok, desde: '2026-10-01', hasta: '2026-10-31' });
    assert.throws(() => validateGenerar({ solicitud_id: 'gen-1234abcd' }), /confirmar/);
    assert.throws(() => validateGenerar({ confirmar: true, solicitud_id: 'corto' }), /solicitud_id/);
    assert.throws(() => validateGenerar({ ...ok, grupos: ['x:1:MXN'] }), /claves/);
    assert.throws(() => validateGenerar({ ...ok, grupos: ['p:23:MXN', 'p:23:MXN'] }), /repetidas/);
});

test('servicio: rutas de ReportesSandbox y respuestas revisadas', async () => {
    const calls = [];
    const api = { request: async (m, p, o) => { calls.push([m, p, o.params ?? null, o.data ?? null]); return p.endsWith('vista-previa') ? { grupos: [] } : { creadas: [] }; } };
    const s = new GeneracionService('636939444', { api });
    await s.vistaPrevia({ desde: '2026-10-01', hasta: '2026-10-31' });
    await s.generar({ confirmar: true, solicitud_id: 'gen-1234abcd', grupos: ['p:23:MXN'] });
    assert.deepEqual(calls, [
        ['get', '/prebills/generar/vista-previa', { desde: '2026-10-01', hasta: '2026-10-31' }, null],
        ['post', '/prebills/generar', null, { confirmar: true, solicitud_id: 'gen-1234abcd', grupos: ['p:23:MXN'] }],
    ]);
    const raro = new GeneracionService('636939444', { api: { request: async () => ({ ok: 1 }) } });
    await assert.rejects(raro.generar({ confirmar: true, solicitud_id: 'gen-1234abcd' }), e => e.status === 502 && e.outcome_unknown === true);
    await assert.rejects(s.generar({}), e => e.status === 400);
});
