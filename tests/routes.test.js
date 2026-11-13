import test from 'node:test';
import assert from 'node:assert/strict';
import app, { CATALOGS } from '../index.js';

// Sin red: sin contexto de Catalyst la conexión falla antes de salir, y debe responder 503 en JSON.
test('rutas: lecturas, validación sin red, facturar bloqueado y sin conexión 503', async () => {
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/636939444`;
    const send = (method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const original = console.error; console.error = () => {};
    try {
        for (const path of [...Object.keys(CATALOGS), 'prebills/7', 'prebills/7/disponible', 'prebills/7/movimientos', 'prebills/7/vista-factura', 'prebills/7/edicion']) {
            const r = await send('GET', '/' + path);
            assert.equal(r.status, 503, path);
            assert.equal((await r.json()).stage, 'connection');
        }
        // Facturar y deshacer: nunca llegan a la API
        let r = await send('POST', '/prebills/7/estado', { nuevo_estado: 'facturada' });
        assert.equal(r.status, 403);
        assert.equal((await send('POST', '/prebills/7/deshacer-factura', {})).status, 404);
        assert.equal((await send('GET', '/tarifas')).status, 404);
        r = await send('GET', '/a/b/c/d');
        assert.equal(r.status, 404); assert.equal((await r.json()).stage, undefined);
        // Validación antes de la red
        assert.equal((await send('POST', '/prebills', { cliente_id: '1', moneda: 'MXN' })).status, 400);
        assert.equal((await send('PATCH', '/prebills/7/lineas', {})).status, 400);
        assert.equal((await send('PATCH', '/prebills/7/descuento-ajuste', { descuento_tipo: 'porcentaje', descuento_valor: 150 })).status, 400);
        assert.equal((await send('PATCH', '/prebills/x/idioma', { idioma: 'en' })).status, 400);
        // Datos válidos: fallan en la conexión, sin resultado incierto
        r = await send('POST', '/prebills', { cliente_id: '1', moneda: 'MXN', tiempo_id: [80] });
        assert.equal(r.status, 503); assert.equal((await r.json()).outcome_unknown, false);
        assert.equal((await send('DELETE', '/prebills/7')).status, 503);
    } finally { server.close(); console.error = original; }
});
